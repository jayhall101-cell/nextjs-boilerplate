"use client";

import { useEffect, useMemo, useState } from "react";

type Technician = {
  id: number;
  name: string;
};

type Job = {
  id: number;
  job_date: string;
  job_type: string;
  points: number;
  complaint_flag: boolean;
  quality_deduction: number;
  technician_id: number | null;
};

function normalizeUrl(base?: string) {
  if (!base) return undefined;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

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

async function adminAction(payload: any) {
  const token = process.env.NEXT_PUBLIC_ADMIN_API_TOKEN;
  if (!token) throw new Error("Set NEXT_PUBLIC_ADMIN_API_TOKEN.");

  const res = await fetch("/api/admin/quality", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...payload }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Admin action failed");
  }
  return res.json();
}

function buildJobsQuery(opts: {
  limit: number;
  offset: number;
  technicianId: string;
  startDate: string;
  endDate: string;
}) {
  const q = [
    "select=id,job_type,job_date:date,points,complaint_flag,quality_deduction,technician_id",
    "order=date.desc",
    `limit=${opts.limit}`,
    `offset=${opts.offset}`,
  ];

  if (opts.technicianId) q.push(`technician_id=eq.${opts.technicianId}`);
  if (opts.startDate) q.push(`date=gte.${opts.startDate}`);
  if (opts.endDate) q.push(`date=lte.${opts.endDate}`);
  return q.join("&");
}

export default function QualityPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [technicians, setTechnicians] = useState<Technician[]>([]);

  const [selectedTechnicianId, setSelectedTechnicianId] = useState<string>("");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [limit, setLimit] = useState<number>(50);
  const [offset, setOffset] = useState<number>(0);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const techMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of technicians) m.set(t.id, t.name);
    return m;
  }, [technicians]);

  const pointsNet = useMemo(() => {
    let total = 0;
    for (const j of jobs) total += (j.points || 0) - (j.quality_deduction || 0);
    return total;
  }, [jobs]);

  const hasNextPage = useMemo(() => jobs.length === limit, [jobs.length, limit]);

async function refreshCurrent() {
    setLoading(true);
    setError(null);
    try {
      const data = await supabaseRestGet<Job[]>(
        "jobs",
        buildJobsQuery({
          limit,
          offset,
          technicianId: selectedTechnicianId,
          startDate,
          endDate,
        })
      );
      setJobs(data);
    } catch (e: any) {
      setError(e?.message || "Refresh failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    supabaseRestGet<Technician[]>("technicians", "select=id,name&order=name.asc")
      .then(setTechnicians)
      .catch(() => void 0);
  }, []);

  useEffect(() => {
    refreshCurrent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTechnicianId, startDate, endDate, limit, offset]);

  function reset() {
    setSelectedTechnicianId("");
    setStartDate("");
    setEndDate("");
    setLimit(50);
    setOffset(0);
  }

  function applyFilters() {
    setOffset(0);
    // refreshCurrent will run via dependency effect
  }

  function prevPage() {
    setOffset((prev) => Math.max(0, prev - limit));
  }

  function nextPage() {
    if (!hasNextPage) return;
    setOffset((prev) => prev + limit);
  }

  async function runImport() {
    if (!confirm("Run import from job_import? This will migrate rows and mark them as migrated_at.")) return;
    setLoading(true);
    setError(null);
    try {
      await adminAction({ action: "run_import" });
      await refreshCurrent();
    } catch (e: any) {
      setError(e?.message || "Import failed");
    } finally {
      setLoading(false);
    }
  }

  async function toggleComplaint(job: Job) {
    const next = !job.complaint_flag;
    const label = next ? "mark this as a complaint" : "clear the complaint flag";
    if (!confirm(`Confirm: ${label} for ${job.job_date} (${job.job_type})?`)) return;

    setLoading(true);
    setError(null);
    try {
      await adminAction({ action: "complaint", job_id: job.id, complaint: next });
      await refreshCurrent();
    } catch (e: any) {
      setError(e?.message || "Complaint update failed");
    } finally {
      setLoading(false);
    }
  }

  async function setDeduction(job: Job) {
    const input = prompt("Quality deduction (points):", String(job.quality_deduction || 0));
    if (input == null) return;
    const n = Number(input);
    if (!Number.isFinite(n) || n < 0) {
      alert("Enter a non-negative number");
      return;
    }
    if (!confirm(`Set deduction to ${n} for ${job.job_date} (${job.job_type})?`)) return;

    setLoading(true);
    setError(null);
    try {
      await adminAction({ action: "deduction", job_id: job.id, deduction: n });
      await refreshCurrent();
    } catch (e: any) {
      setError(e?.message || "Deduction update failed");
    } finally {
      setLoading(false);
    }
  }

  async function exportCsv() {
    const token = process.env.NEXT_PUBLIC_ADMIN_API_TOKEN;
    if (!token) {
      alert("Set NEXT_PUBLIC_ADMIN_API_TOKEN.");
      return;
    }

    const params = new URLSearchParams();
    params.set("token", token);
    if (selectedTechnicianId) params.set("technician_id", selectedTechnicianId);
    if (startDate) params.set("start", startDate);
    if (endDate) params.set("end", endDate);
    params.set("limit", "1000");

    const res = await fetch(`/api/admin/quality/export?${params.toString()}`);
    if (!res.ok) {
      const txt = await res.text();
      setError(txt || "Export failed");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `quality_export_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={runImport}
            disabled={loading}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-700"
          >
            {loading ? "Working…" : "Run import"}
          </button>
          <button
            onClick={exportCsv}
            disabled={loading}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Export CSV
          </button>
        </div>

        <div className="text-sm text-zinc-500 dark:text-zinc-400">
          Net points (sample view):{" "}
          <span className="font-semibold text-zinc-900 dark:text-zinc-50">
            {pointsNet}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">Technician</label>
          <select
            value={selectedTechnicianId}
            onChange={(e) => setSelectedTechnicianId(e.target.value)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">All</option>
            {technicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">Start date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">End date</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">Page size</label>
          <select
            value={String(limit)}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <button
            onClick={applyFilters}
            disabled={loading}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Apply
          </button>
          <button
            onClick={reset}
            disabled={loading}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Reset
          </button>
          <button
            onClick={refreshCurrent}
            disabled={loading}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {error}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-700">
        <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-700">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-950">
              {["Date", "Tech", "Type", "Points", "Complaint", "Deduction", "Net", "Actions"].map((c) => (
                <th
                  key={c}
                  className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-700">
            {jobs.map((j) => {
              const techName = j.technician_id ? techMap.get(j.technician_id) : undefined;
              const net = (j.points || 0) - (j.quality_deduction || 0);
              return (
                <tr key={j.id}>
                  <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.job_date}</td>
                  <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{techName ?? "—"}</td>
                  <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.job_type}</td>
                  <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.points}</td>
                  <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.complaint_flag ? "Yes" : "No"}</td>
                  <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.quality_deduction}</td>
                  <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{net}</td>
                  <td className="px-4 py-2 text-sm">
                    <div className="flex gap-2">
                      <button
                        onClick={() => toggleComplaint(j)}
                        disabled={loading}
                        className="rounded-lg border border-zinc-200 px-2 py-1 text-xs font-medium dark:border-zinc-700"
                      >
                        Toggle complaint
                      </button>
                      <button
                        onClick={() => setDeduction(j)}
                        disabled={loading}
                        className="rounded-lg border border-zinc-200 px-2 py-1 text-xs font-medium dark:border-zinc-700"
                      >
                        Set deduction
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-zinc-500 dark:text-zinc-400">
          Showing {jobs.length} • Page {Math.floor(offset / limit) + 1}
        </div>
        <div className="flex gap-2">
          <button
            onClick={prevPage}
            disabled={loading || offset <= 0}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Prev
          </button>
          <button
            onClick={nextPage}
            disabled={loading || !hasNextPage}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
