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

async function supabaseRestInsert(table: string, payload: unknown) {
  const base = normalizeUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !key) throw new Error("Supabase env vars missing");

  const url = `${base}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Supabase insert failed: ${res.status}`);
  return res.json();
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
  const byMonth: Record<string, { year: number; month: number; techs: Record<string, { jobs: number; points: number }> }> = {};

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
      byMonth[monthKey].techs[tech] = { jobs: 0, points: 0 };
    }
    byMonth[monthKey].techs[tech].jobs += 1;
    byMonth[monthKey].techs[tech].points += pts;
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
                columns={['Month', 'Jobs', 'Points']}
                rows={aggregates.monthlyBreakdown.map((m) => [
                  m.label,
                  m.techs[t.id]?.jobs ?? 0,
                  number(m.techs[t.id]?.points ?? 0),
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
    return (
      <div className="space-y-4">
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
          <h2 className="mb-2 text-sm font-semibold text-zinc-500 dark:text-zinc-400">
            Most recent jobs
            <span className="ml-3 text-xs font-normal text-red-500 dark:text-red-400">⚠ = client returned within 30 days (originating tech forfeits points)</span>
          </h2>
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
                {jobs.slice(0, 30).map((j, i) => {
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
