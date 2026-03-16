"use client";

import { useEffect, useMemo, useState } from "react";

// Scoring rules
export type JobType =
  | "WIFI_INSTALL"
  | "FIBER_INSTALL"
  | "REMOVAL"
  | "OUTAGE"
  | "FIBER_SUPPORT"
  | "WIFI_SUPPORT";

const POINTS: Record<JobType, number> = {
  WIFI_INSTALL: 5,
  FIBER_INSTALL: 6,
  REMOVAL: 1,
  OUTAGE: 5,
  FIBER_SUPPORT: 4,
  WIFI_SUPPORT: 3,
};

export type Technician = {
  id: string;
  name: string;
};

export type Job = {
  id?: string;
  technician_id: string;
  technician_name?: string;
  job_type: JobType;
  job_date: string; // YYYY-MM-DD
  client_name?: string;
  notes?: string;
};

type View = "Dashboard" | "Technicians" | "Log" | "Executive";

function normalizeUrl(base?: string) {
  if (!base) return undefined;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function isoDateOnly(d: Date) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function startOfWeek(date: Date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date: Date) {
  const d = startOfWeek(date);
  d.setDate(d.getDate() + 6);
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfMonth(date: Date) {
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfMonth(date: Date) {
  const d = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  d.setHours(23, 59, 59, 999);
  return d;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function supabaseRestGet<T>(table: string, query: string) {
  const base = normalizeUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !key) throw new Error("Supabase env vars missing");

  const url = `${base}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function supabaseRestInsert(table: string, payload: unknown, ignoreDuplicates = false) {
  const base = normalizeUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !key) throw new Error("Supabase env vars missing");

  const url = `${base}/rest/v1/${table}`;
  const prefer = ignoreDuplicates
    ? "resolution=ignore-duplicates,return=representation"
    : "return=representation";
  const res = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Supabase insert failed: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

function pointsFor(job: Pick<Job, "job_type">) {
  return POINTS[job.job_type] ?? 0;
}

/**
 * Returns a Set of job IDs that are penalized due to a repeat client visit
 * within 30 days of the original job (ANY technician).
 *
 * Rule: if client C appears again within 30 days of a previous job (regardless
 * of which technician), the ORIGINAL job loses its points. The new technician
 * keeps their points. This chains — a 3rd visit within 30 days of the 2nd
 * also penalizes the 2nd job.
 */
function computePenalties(jobs: Job[]): Set<string> {
  const penalized = new Set<string>();

  // Sort ascending by date — group by client name only (cross-technician)
  const sorted = [...jobs]
    .filter((j) => j.id && j.client_name && j.client_name.trim() !== "")
    .sort((a, b) => a.job_date.localeCompare(b.job_date));

  // Group by client name only (case-insensitive) — technician doesn't matter
  const groups: Record<string, Job[]> = {};
  for (const job of sorted) {
    const key = job.client_name!.trim().toLowerCase();
    (groups[key] ??= []).push(job);
  }

  for (const jobList of Object.values(groups)) {
    if (jobList.length < 2) continue;
    for (let i = 1; i < jobList.length; i++) {
      const repeat = jobList[i];
      const original = jobList[i - 1];
      const [ry, rm, rd] = repeat.job_date.split("-").map(Number);
      const [oy, om, od] = original.job_date.split("-").map(Number);
      const daysDiff = (new Date(ry, rm - 1, rd).getTime() - new Date(oy, om - 1, od).getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff <= 30 && original.id) {
        penalized.add(original.id);
      }
    }
  }
  return penalized;
}

function computeAggregates(jobs: Job[], techniciansById: Record<string, Technician>, penalized: Set<string>) {
  const now = new Date();
  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(now);
  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);

  const byTech: Record<string, { total: number; week: number; month: number; jobsAll: number; jobsWeek: number; jobsMonth: number }>
    = {};

  let totalAll = 0;
  let totalWeek = 0;
  let totalMonth = 0;

  const jobCountsByTypeWeek: Record<JobType, number> = {
    WIFI_INSTALL: 0,
    FIBER_INSTALL: 0,
    REMOVAL: 0,
    OUTAGE: 0,
    FIBER_SUPPORT: 0,
    WIFI_SUPPORT: 0,
  };
  const jobCountsByTypeMonth: Record<JobType, number> = {
    WIFI_INSTALL: 0,
    FIBER_INSTALL: 0,
    REMOVAL: 0,
    OUTAGE: 0,
    FIBER_SUPPORT: 0,
    WIFI_SUPPORT: 0,
  };

  // Monthly breakdown per technician: byMonth[monthKey][techId]
  const byMonth: Record<string, { year: number; month: number; techs: Record<string, { jobs: number; points: number; repeats: number }> }> = {};

  for (const job of jobs) {
    // Parse date as local time to avoid UTC timezone shift
    const [yr, mo, dy] = job.job_date.split("-").map(Number);
    const d = new Date(yr, mo - 1, dy);
    const pts = job.id && penalized.has(job.id) ? 0 : pointsFor(job);
    const tech = job.technician_id;

    const bucket = (byTech[tech] ??= { total: 0, week: 0, month: 0, jobsAll: 0, jobsWeek: 0, jobsMonth: 0 });

    const inWeek = d >= weekStart && d <= weekEnd;
    const inMonth = d >= monthStart && d <= monthEnd;

    bucket.total += pts;
    bucket.jobsAll += 1;
    totalAll += pts;

    if (inWeek) {
      bucket.week += pts;
      bucket.jobsWeek += 1;
      totalWeek += pts;
      jobCountsByTypeWeek[job.job_type] += 1;
    }

    if (inMonth) {
      bucket.month += pts;
      bucket.jobsMonth += 1;
      totalMonth += pts;
      jobCountsByTypeMonth[job.job_type] += 1;
    }

    // Monthly per-tech rollup
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!byMonth[monthKey]) {
      byMonth[monthKey] = { year: d.getFullYear(), month: d.getMonth(), techs: {} };
    }
    if (!byMonth[monthKey].techs[tech]) {
      byMonth[monthKey].techs[tech] = { jobs: 0, points: 0, repeats: 0 };
    }
    byMonth[monthKey].techs[tech].jobs += 1;
    byMonth[monthKey].techs[tech].points += pts;
    if (job.id && penalized.has(job.id)) byMonth[monthKey].techs[tech].repeats += 1;
  }

  const leaderboardWeek = Object.entries(byTech)
    .map(([id, stats]) => ({ id, name: techniciansById[id]?.name ?? id, ...stats }))
    .sort((a, b) => b.week - a.week);

  const leaderboardMonth = Object.entries(byTech)
    .map(([id, stats]) => ({ id, name: techniciansById[id]?.name ?? id, ...stats }))
    .sort((a, b) => b.month - a.month);

  const monthlyBreakdown = Object.entries(byMonth)
    .sort((a, b) => b[0].localeCompare(a[0])) // most recent first
    .map(([key, val]) => ({
      key,
      label: `${MONTH_NAMES[val.month]} ${val.year}`,
      techs: val.techs,
      totalJobs: Object.values(val.techs).reduce((s, t) => s + t.jobs, 0),
      totalPoints: Object.values(val.techs).reduce((s, t) => s + t.points, 0),
    }));

  return {
    weekStart: isoDateOnly(weekStart),
    weekEnd: isoDateOnly(weekEnd),
    monthStart: isoDateOnly(monthStart),
    monthEnd: isoDateOnly(monthEnd),
    totals: { all: totalAll, week: totalWeek, month: totalMonth },
    jobCountsByTypeWeek,
    jobCountsByTypeMonth,
    leaderboardWeek,
    leaderboardMonth,
    monthlyBreakdown,
  };
}

function Card({ title, value, subtitle }: { title: string; value: string | number; subtitle?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
      <div className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{title}</div>
      <div className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{value}</div>
      {subtitle ? <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</div> : null}
    </div>
  );
}

function Table({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-700">
      <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-700">
        <thead>
          <tr className="bg-zinc-50 dark:bg-zinc-950">
            {columns.map((c) => (
              <th key={c} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-700">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── CSV Import helpers ────────────────────────────────────────────────────────

const TECH_NAME_MAP: Record<string, number> = {
  "mark collington": 1,
  "odane dixon": 2,
  "odane  dixon": 2, // double-space variant
};

function inferJobType(title: string): JobType {
  const t = title.toLowerCase();
  if (t.includes("fiber install") || t.includes("fiber installation")) return "FIBER_INSTALL";
  if (t.includes("wifi install") || t.includes("wi-fi install") || t.includes("installation") || t.includes("relocation")) return "WIFI_INSTALL";
  if (t.includes("fiber support")) return "FIBER_SUPPORT";
  if (t.includes("support")) return "WIFI_SUPPORT";
  if (t.includes("removal")) return "REMOVAL";
  if (t.includes("outage")) return "OUTAGE";
  return "WIFI_SUPPORT";
}

type CsvRow = {
  technician_id: number;
  technician_name: string;
  date: string;
  job_type: JobType;
  points: number;
  client_name: string;
  error?: string;
};

function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const idx = (name: string) => headers.indexOf(name);

  return lines.slice(1).map((line) => {
    // Handle quoted fields with commas inside
    const cols: string[] = [];
    let inQuote = false, cur = "";
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === "," && !inQuote) { cols.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
    cols.push(cur.trim());

    const get = (name: string) => (cols[idx(name)] ?? "").replace(/^"|"$/g, "").trim();
    const title = get("title");
    const dateRaw = get("date").slice(0, 10);
    const techRaw = get("assigned user");
    const client = get("client");

    const tech_id = TECH_NAME_MAP[techRaw.toLowerCase()];
    if (!tech_id) return { technician_id: 0, technician_name: techRaw, date: dateRaw, job_type: "WIFI_SUPPORT" as JobType, points: 0, client_name: client, error: `Unknown technician: "${techRaw}"` };

    const job_type = inferJobType(title);
    return { technician_id: tech_id, technician_name: techRaw, date: dateRaw, job_type, points: POINTS[job_type], client_name: client };
  }).filter((r) => r.date && r.date.match(/^\d{4}-\d{2}-\d{2}$/));
}

// ── End CSV Import helpers ─────────────────────────────────────────────────────

export default function Home() {
  const [view, setView] = useState<View>("Dashboard");
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const techniciansById = useMemo(() => {
    const map: Record<string, Technician> = {};
    for (const t of technicians) map[t.id] = t;
    return map;
  }, [technicians]);

  const penalized = useMemo(() => computePenalties(jobs), [jobs]);
  const aggregates = useMemo(() => computeAggregates(jobs, techniciansById, penalized), [jobs, techniciansById, penalized]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [techs, jobData] = await Promise.all([
          supabaseRestGet<Technician[]>("technicians", "select=*&order=name.asc"),
          supabaseRestGet<Job[]>("jobs", "select=id,technician_id,job_type,job_date:date,points,client_name&order=date.desc"),
        ]);
        if (cancelled) return;
        setTechnicians(techs);
        setJobs(jobData);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message ?? "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [rowsToInsert, setRowsToInsert] = useState<Array<Partial<Job>>>([
    { job_date: isoDateOnly(new Date()), job_type: "WIFI_INSTALL" },
  ]);

  async function handleInsert() {
    setLoading(true);
    setError(null);
    try {
      const payload: any[] = rowsToInsert
        .filter((r) => !!r.job_date && !!r.job_type && !!r.technician_id)
        .map((r) => ({
          technician_id: Number(r.technician_id!),
          job_type: r.job_type as JobType,
          date: r.job_date!,
          points: pointsFor({ job_type: r.job_type as JobType }),
          complaint_flag: false,
          ...(r.client_name ? { client_name: r.client_name } : {}),
        }));
      if (!payload.length) throw new Error("Add at least one complete row");

      await supabaseRestInsert("jobs", payload);
      const jobData = await supabaseRestGet<Job[]>("jobs", "select=id,technician_id,job_type,job_date:date,points,client_name&order=date.desc");
      setJobs(jobData);
      setRowsToInsert([{ job_date: isoDateOnly(new Date()), job_type: "WIFI_INSTALL" }]);
      setView("Dashboard");
    } catch (e: any) {
      setError(e?.message ?? "Insert failed");
    } finally {
      setLoading(false);
    }
  }

  const number = (n: number) => new Intl.NumberFormat().format(n);

  const buttonActive = "rounded-lg px-3 py-2 text-sm font-medium bg-zinc-900 text-white dark:bg-zinc-50 dark:text-black";
  const buttonInactive = "rounded-lg px-3 py-2 text-sm font-medium border border-zinc-200 dark:border-zinc-700";

  function DashboardView() {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <Card title="Points" value={number(aggregates.totals.week)} subtitle={`Week (${aggregates.weekStart} – ${aggregates.weekEnd})`} />
          <Card title="Points" value={number(aggregates.totals.month)} subtitle={`Month (${aggregates.monthStart} – ${aggregates.monthEnd})`} />
          <Card title="Points" value={number(aggregates.totals.all)} subtitle="All time" />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h2 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">Job volume by type (Week)</h2>
            <Table
              columns={['Job type', 'Points each', 'Jobs']}
              rows={[
                ['WiFi Install', POINTS.WIFI_INSTALL, aggregates.jobCountsByTypeWeek.WIFI_INSTALL],
                ['Fiber Install', POINTS.FIBER_INSTALL, aggregates.jobCountsByTypeWeek.FIBER_INSTALL],
                ['Removal', POINTS.REMOVAL, aggregates.jobCountsByTypeWeek.REMOVAL],
                ['Outage', POINTS.OUTAGE, aggregates.jobCountsByTypeWeek.OUTAGE],
                ['Fiber Support', POINTS.FIBER_SUPPORT, aggregates.jobCountsByTypeWeek.FIBER_SUPPORT],
                ['WiFi Support', POINTS.WIFI_SUPPORT, aggregates.jobCountsByTypeWeek.WIFI_SUPPORT],
              ]}
            />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">Leaderboard (Week)</h2>
            <Table columns={['Tech', 'Points', 'Jobs']} rows={aggregates.leaderboardWeek.map((x) => [x.name, x.week, x.jobsWeek])} />
          </div>
        </div>

        {/* Monthly breakdown - one table per technician */}
        <div className="grid gap-4 md:grid-cols-2">
          {aggregates.leaderboardWeek.map((t) => (
            <div key={t.id}>
              <h2 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">{t.name} — Monthly breakdown</h2>
              <Table
                columns={['Month', 'Jobs', 'Points', 'Repeats']}
                rows={aggregates.monthlyBreakdown.map((m) => [
                  m.label,
                  m.techs[t.id]?.jobs ?? 0,
                  number(m.techs[t.id]?.points ?? 0),
                  m.techs[t.id]?.repeats ?? 0,
                ])}
              />
            </div>
          ))}
        </div>

        {/* Repeat clients table */}
        {(() => {
          const repeatRows = jobs
            .filter((j) => j.id && penalized.has(j.id))
            .sort((a, b) => b.job_date.localeCompare(a.job_date))
            .map((j) => [
              j.job_date,
              techniciansById[j.technician_id]?.name ?? j.technician_id,
              j.job_type.replace(/_/g, " "),
              j.client_name ?? "—",
              `-${pointsFor(j)}`,
            ]);
          return (
            <div>
              <h2 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">
                Repeat clients — points lost
                <span className="ml-2 text-xs font-normal text-zinc-400">({repeatRows.length} penalized job{repeatRows.length !== 1 ? "s" : ""})</span>
              </h2>
              {repeatRows.length === 0 ? (
                <p className="text-xs text-zinc-400 dark:text-zinc-500">No repeat clients detected this year.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-700">
                  <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-700">
                    <thead>
                      <tr className="bg-zinc-50 dark:bg-zinc-950">
                        {['Job Date', 'Technician', 'Job Type', 'Client', 'Points Lost'].map((c) => (
                          <th key={c} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200 dark:divide-zinc-700">
                      {repeatRows.map((row, i) => (
                        <tr key={i} className="bg-red-50 dark:bg-red-950/20">
                          <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{row[0]}</td>
                          <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{row[1]}</td>
                          <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{row[2]}</td>
                          <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{row[3]}</td>
                          <td className="px-4 py-2 text-sm font-semibold text-red-500 dark:text-red-400">{row[4]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    );
  }

  function TechniciansView() {
    const rows = aggregates.leaderboardWeek.map((x) => [x.name, x.jobsWeek, x.week, x.jobsMonth, x.month, x.jobsAll, x.total]);
    return (
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Technician rollup</h2>
        <Table columns={['Tech', 'Jobs W', 'Points W', 'Jobs M', 'Points M', 'Jobs All', 'Points All']} rows={rows} />
      </div>
    );
  }

  function LogView() {
    const [showAllJobs, setShowAllJobs] = useState(false);
    const displayedJobs = showAllJobs ? jobs : jobs.slice(0, 30);

    // CSV import state
    const [csvRows, setCsvRows] = useState<CsvRow[]>([]);
    const [csvFileName, setCsvFileName] = useState<string>("");
    const [csvImporting, setCsvImporting] = useState(false);
    const [csvResult, setCsvResult] = useState<string | null>(null);

    function handleCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
      const file = e.target.files?.[0];
      if (!file) return;
      setCsvFileName(file.name);
      setCsvResult(null);
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        const parsed = parseCsv(text);
        setCsvRows(parsed);
      };
      reader.readAsText(file);
      e.target.value = "";
    }

    async function handleCsvImport() {
      const valid = csvRows.filter((r) => !r.error);
      if (!valid.length) return;
      setCsvImporting(true);
      setCsvResult(null);
      try {
        // Check for duplicates against existing jobs
        const existingKeys = new Set(
          jobs.map((j) => `${j.technician_id}__${j.job_date}__${(j.client_name ?? "").toLowerCase()}`)
        );
        const toInsert = valid.filter(
          (r) => !existingKeys.has(`${r.technician_id}__${r.date}__${r.client_name.toLowerCase()}`)
        );
        if (!toInsert.length) {
          setCsvResult("⚠ All jobs in this file already exist in the database — nothing imported.");
          return;
        }
        const payload = toInsert.map((r) => ({
          technician_id: r.technician_id,
          quarter_id: 1,
          date: r.date,
          job_type: r.job_type,
          points: r.points,
          complaint_flag: false,
          quality_deduction: 0,
          client_name: r.client_name || null,
        }));
        const inserted = await supabaseRestInsert("jobs", payload, true);
        const importedCount = Array.isArray(inserted) ? inserted.length : toInsert.length;
        const skipped = valid.length - importedCount;
        const jobData = await supabaseRestGet<Job[]>("jobs", "select=id,technician_id,job_type,job_date:date,points,client_name&order=date.desc");
        setJobs(jobData);
        setCsvResult(`✅ Imported ${importedCount} job${importedCount !== 1 ? "s" : ""}${skipped > 0 ? ` (${skipped} skipped as duplicates)` : ""}.`);
        setCsvRows([]);
        setCsvFileName("");
      } catch (err: any) {
        setCsvResult(`❌ Import failed: ${err?.message ?? "Unknown error"}`);
      } finally {
        setCsvImporting(false);
      }
    }

    return (
      <div className="space-y-4">

        {/* ── CSV Import ── */}
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-center justify-between gap-4 mb-3">
            <div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Import CSV</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">Upload an export file — jobs are parsed and previewed before import.</div>
            </div>
            <label className="cursor-pointer rounded-lg border border-zinc-300 dark:border-zinc-600 bg-zinc-50 dark:bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700">
              {csvFileName ? `📄 ${csvFileName}` : "Choose CSV file"}
              <input type="file" accept=".csv" className="hidden" onChange={handleCsvFile} />
            </label>
          </div>

          {csvRows.length > 0 && (
            <>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  Preview — {csvRows.filter(r => !r.error).length} valid / {csvRows.filter(r => r.error).length} errors
                  {" · "}date range: {csvRows.filter(r=>!r.error).map(r=>r.date).sort()[0]} → {csvRows.filter(r=>!r.error).map(r=>r.date).sort().slice(-1)[0]}
                </span>
                <button
                  onClick={handleCsvImport}
                  disabled={csvImporting || csvRows.filter(r => !r.error).length === 0}
                  className="rounded-lg bg-zinc-900 dark:bg-white px-4 py-1.5 text-xs font-semibold text-white dark:text-zinc-900 hover:opacity-90 disabled:opacity-50"
                >
                  {csvImporting ? "Importing…" : `Import ${csvRows.filter(r => !r.error).length} jobs`}
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
                <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-700 text-xs">
                  <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-950">
                    <tr>
                      {["Date", "Technician", "Job Type", "Client", "Points", ""].map((h) => (
                        <th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-700">
                    {csvRows.map((r, i) => (
                      <tr key={i} className={r.error ? "bg-red-50 dark:bg-red-950/30" : ""}>
                        <td className="px-3 py-1.5 text-zinc-900 dark:text-zinc-50">{r.date}</td>
                        <td className="px-3 py-1.5 text-zinc-900 dark:text-zinc-50">{r.technician_name}</td>
                        <td className="px-3 py-1.5 text-zinc-900 dark:text-zinc-50">{r.error ? "—" : r.job_type.replace(/_/g, " ")}</td>
                        <td className="px-3 py-1.5 text-zinc-900 dark:text-zinc-50">{r.client_name}</td>
                        <td className="px-3 py-1.5 text-zinc-900 dark:text-zinc-50">{r.error ? "—" : r.points}</td>
                        <td className="px-3 py-1.5 text-red-500">{r.error ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {csvResult && (
            <p className={`mt-3 text-sm font-medium ${csvResult.startsWith("✅") ? "text-green-600 dark:text-green-400" : csvResult.startsWith("⚠") ? "text-amber-500" : "text-red-500"}`}>
              {csvResult}
            </p>
          )}
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Admin job entry</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">Bulk add rows, like a spreadsheet.</div>
            </div>
            <button
              onClick={() => setRowsToInsert((r) => [...r, { job_date: isoDateOnly(new Date()), job_type: "WIFI_INSTALL" }])}
              className="rounded-lg border border-zinc-200 px-3 py-1 text-xs font-medium dark:border-zinc-700"
            >
              + Add row
            </button>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-700">
              <thead>
                <tr className="bg-zinc-50 dark:bg-zinc-950">
                  {['Date', 'Technician', 'Job type', 'Client', 'Notes'].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-700">
                {rowsToInsert.map((r, idx) => (
                  <tr key={idx}>
                    <td className="px-4 py-2">
                      <input
                        type="date"
                        value={r.job_date ?? ""}
                        onChange={(e) =>
                          setRowsToInsert((rows) => {
                            const copy = [...rows];
                            copy[idx] = { ...copy[idx], job_date: e.target.value };
                            return copy;
                          })
                        }
                        className="w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={r.technician_id ?? ""}
                        onChange={(e) =>
                          setRowsToInsert((rows) => {
                            const copy = [...rows];
                            copy[idx] = { ...copy[idx], technician_id: e.target.value };
                            return copy;
                          })
                        }
                        className="w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        <option value="">Pick a tech…</option>
                        {technicians.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={r.job_type ?? "WIFI_INSTALL"}
                        onChange={(e) =>
                          setRowsToInsert((rows) => {
                            const copy = [...rows];
                            copy[idx] = { ...copy[idx], job_type: e.target.value as JobType };
                            return copy;
                          })
                        }
                        className="w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      >
                        <option value="WIFI_INSTALL">WiFi Install</option>
                        <option value="FIBER_INSTALL">Fiber Install</option>
                        <option value="REMOVAL">Removal</option>
                        <option value="OUTAGE">Outage</option>
                        <option value="FIBER_SUPPORT">Fiber Support</option>
                        <option value="WIFI_SUPPORT">WiFi Support</option>
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <input
                        value={r.client_name ?? ""}
                        onChange={(e) =>
                          setRowsToInsert((rows) => {
                            const copy = [...rows];
                            copy[idx] = { ...copy[idx], client_name: e.target.value };
                            return copy;
                          })
                        }
                        placeholder="Client name"
                        className="w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <input
                        value={r.notes ?? ""}
                        onChange={(e) =>
                          setRowsToInsert((rows) => {
                            const copy = [...rows];
                            copy[idx] = { ...copy[idx], notes: e.target.value };
                            return copy;
                          })
                        }
                        placeholder="Optional"
                        className="w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex gap-2">
            <button onClick={handleInsert} disabled={loading} className={buttonActive}>
              {loading ? "Saving…" : "Submit rows"}
            </button>
            <button
              onClick={() => setRowsToInsert([{ job_date: isoDateOnly(new Date()), job_type: "WIFI_INSTALL" }])}
              disabled={loading}
              className={buttonInactive}
            >
              Reset
            </button>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">
              {showAllJobs ? `All jobs (${jobs.length})` : "Most recent jobs (30)"}
              <span className="ml-3 text-xs font-normal text-red-500 dark:text-red-400">⚠ = client returned within 30 days (originating tech forfeits points)</span>
            </h2>
            <button
              onClick={() => setShowAllJobs((v) => !v)}
              className="rounded-lg border border-zinc-200 px-3 py-1 text-xs font-medium dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              {showAllJobs ? "Show recent only" : `All jobs (${jobs.length})`}
            </button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-700">
            <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-700">
              <thead>
                <tr className="bg-zinc-50 dark:bg-zinc-950">
                  {['Date', 'Technician', 'Type', 'Client', 'Points', 'Notes'].map((c) => (
                    <th key={c} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-700">
                {displayedJobs.map((j, i) => {
                  const isPenalized = !!j.id && penalized.has(j.id);
                  const effectivePts = isPenalized ? 0 : pointsFor(j);
                  return (
                    <tr key={i} className={isPenalized ? "bg-red-50 dark:bg-red-950/20" : ""}>
                      <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.job_date}</td>
                      <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{techniciansById[j.technician_id]?.name ?? j.technician_id}</td>
                      <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.job_type.replace("_", " ")}</td>
                      <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.client_name ?? ""}</td>
                      <td className="px-4 py-2 text-sm font-medium">
                        {isPenalized ? (
                          <span className="text-red-500 dark:text-red-400">
                            ⚠ 0 <span className="line-through text-zinc-400 font-normal text-xs">{pointsFor(j)}</span>
                          </span>
                        ) : (
                          <span className="text-zinc-900 dark:text-zinc-50">{effectivePts}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.notes ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  function ExecView() {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h2 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">Top technicians (Week)</h2>
            <Table columns={['Tech', 'Points', 'Jobs']} rows={aggregates.leaderboardWeek.slice(0, 5).map((x) => [x.name, x.week, x.jobsWeek])} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">Top technicians (Month)</h2>
            <Table columns={['Tech', 'Points', 'Jobs']} rows={aggregates.leaderboardMonth.slice(0, 5).map((x) => [x.name, x.month, x.jobsMonth])} />
          </div>
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Note: Supabase Studio (supabase.com) is blocked here. Set your env vars and ensure RLS policies allow the desired inserts.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
          <div className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="Astute Technology Solution"
              className="h-28 w-auto object-contain"
              style={{ filter: "drop-shadow(0 0 8px rgba(255,120,0,0.25))" }}
            />
            <div className="text-xs text-zinc-500 dark:text-zinc-400">Proformans / points tracking</div>
          </div>
          <nav className="flex flex-wrap gap-2">
            {(['Dashboard', 'Technicians', 'Log', 'Executive'] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={view === v ? buttonActive : buttonInactive}
              >
                {v}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-6 py-6">
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
            {error}
          </div>
        ) : null}

        {view === 'Dashboard' ? <DashboardView /> : null}
        {view === 'Technicians' ? <TechniciansView /> : null}
        {view === 'Log' ? <LogView /> : null}
        {view === 'Executive' ? <ExecView /> : null}
      </main>
    </div>
  );
}
