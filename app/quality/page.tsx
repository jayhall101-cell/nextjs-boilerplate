"use client";

import { useEffect, useMemo, useState } from "react";

type Job = {
  id: number;
  job_date: string;
  job_type: string;
  points: number;
  complaint_flag: boolean;
  quality_deduction: number;
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

export default function QualityPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pointsNet = useMemo(() => {
    let total = 0;
    for (const j of jobs) total += (j.points || 0) - (j.quality_deduction || 0);
    return total;
  }, [jobs]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const data = await supabaseRestGet<Job[]>(
        "jobs",
        "select=id,job_type,job_date:date,points,complaint_flag,quality_deduction&order=date.desc&limit=200"
      );
      setJobs(data);
    } catch (e: any) {
      setError(e?.message || "Refresh failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleComplaint(job: Job) {
    setLoading(true);
    setError(null);
    try {
      await adminAction({ action: "complaint", job_id: job.id, complaint: !job.complaint_flag });
      await refresh();
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

    setLoading(true);
    setError(null);
    try {
      await adminAction({ action: "deduction", job_id: job.id, deduction: n });
      await refresh();
    } catch (e: any) {
      setError(e?.message || "Deduction update failed");
    } finally {
      setLoading(false);
    }
  }

  async function runImport() {
    setLoading(true);
    setError(null);
    try {
      await adminAction({ action: "run_import" });
      await refresh();
    } catch (e: any) {
      setError(e?.message || "Import failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <div className="flex flex-wrap gap-2">
        <button onClick={runImport} disabled={loading} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-700">
          {loading ? "Working…" : "Run import"}
        </button>
        <button onClick={refresh} disabled={loading} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium dark:border-zinc-700">
          Refresh jobs
        </button>
        <div className="text-sm text-zinc-500 dark:text-zinc-400">
          Net points (sample view): <span className="font-semibold text-zinc-900 dark:text-zinc-50">{pointsNet}</span>
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
              {['Date', 'Type', 'Points', 'Complaint', 'Deduction', 'Actions'].map((c) => (
                <th key={c} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-700">
            {jobs.map((j) => (
              <tr key={j.id}>
                <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.job_date}</td>
                <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.job_type}</td>
                <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.points}</td>
                <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.complaint_flag ? 'Yes' : 'No'}</td>
                <td className="px-4 py-2 text-sm text-zinc-900 dark:text-zinc-50">{j.quality_deduction}</td>
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
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
