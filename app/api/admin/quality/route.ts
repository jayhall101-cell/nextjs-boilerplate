import { NextResponse } from "next/server";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN ?? "";

function normalizeJobType(value: string) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

async function pgFetch(path: string, init: RequestInit) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Missing env vars");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(init?.method?.toUpperCase() === "POST" || init?.method?.toUpperCase() === "PATCH"
        ? { "Content-Type": "application/json" }
        : {}),
    },
  });
  if (!res.ok) throw new Error(`PostgREST ${path} failed: ${res.status}`);
  return res;
}

async function pgGet<T>(path: string) {
  const res = await pgFetch(path, { method: "GET" });
  return (await res.json()) as T;
}

async function pgPatch(path: string, body: any) {
  const res = await pgFetch(path, { method: "PATCH", body: JSON.stringify(body), headers: { Prefer: "return=representation" } });
  return res.json();
}

async function pgInsert(path: string, body: any) {
  const res = await pgFetch(path, { method: "POST", body: JSON.stringify(body), headers: { Prefer: "return=representation" } });
  return res.json();
}

function toDay(timestamp: string) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Body =
  | { token: string; action: "complaint"; job_id: number; complaint: boolean }
  | { token: string; action: "deduction"; job_id: number; deduction: number }
  | { token: string; action: "run_import" };

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!ADMIN_TOKEN || body.token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (body.action === "complaint") {
    await pgPatch(`jobs?id=eq.${body.job_id}`, { complaint_flag: body.complaint });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "deduction") {
    const deduction = Math.max(0, Math.round(body.deduction));
    await pgPatch(`jobs?id=eq.${body.job_id}`, { quality_deduction: deduction });
    return NextResponse.json({ ok: true });
  }

  // run_import (also normalizes existing job_type strings)
  const imports = await pgGet<any[]>(
    'job_import?migrated_at=is.null&select=Status,Date,"Assigned user",Client,Title'
  );

  if (!imports.length) return NextResponse.json({ inserted_count: 0 });

  const jobTypes = await pgGet<any[]>('job_types?select=id,job_name,point_value');
  const technicians = await pgGet<any[]>('technicians?select=id,name');
  const quarters = await pgGet<any[]>('quarters?select=id,start_date,end_date');

  const jobTypeByStatus = new Map<number, any>();
  const pointsByNormalized = new Map<string, number>();
  for (const jt of jobTypes) {
    jobTypeByStatus.set(Number(jt.id), jt);
    pointsByNormalized.set(normalizeJobType(jt.job_name), Number(jt.point_value ?? 0));
  }

  const technicianByName = new Map<string, any>();
  for (const t of technicians) {
    technicianByName.set(String(t.name).trim(), t);
  }

  const prepared: any[] = [];
  for (const row of imports) {
    const jt = jobTypeByStatus.get(Number(row.Status));
    const tech = technicianByName.get(String(row["Assigned user"]).trim());
    const jobDate = new Date(row.Date);
    const q = quarters.find((x: any) => {
      const start = new Date(x.start_date);
      const end = new Date(x.end_date);
      return jobDate >= start && jobDate <= end;
    });
    if (!jt || !tech || !q) continue;

    const normalizedJobType = normalizeJobType(jt.job_name);
    const points = pointsByNormalized.get(normalizedJobType) ?? Number(jt.point_value ?? 0);

    prepared.push({
      technician_id: tech.id,
      quarter_id: q.id,
      date: toDay(row.Date),
      job_type: normalizedJobType,
      points,
      complaint_flag: false,
      quality_deduction: 0,
    });
  }

  if (!prepared.length) return NextResponse.json({ inserted_count: 0 });

  await pgInsert('jobs', prepared);

  for (const jt of jobTypes) {
    const label = String(jt.job_name ?? "");
    const normalized = normalizeJobType(label);
    if (!label || label === normalized) continue;
    const points = pointsByNormalized.get(normalized) ?? Number(jt.point_value ?? 0);
    await pgPatch(`jobs?job_type=eq.${encodeURIComponent(label)}`, { job_type: normalized, points });
  }

  await pgPatch('job_import?migrated_at=is.null', { migrated_at: new Date().toISOString() });

  return NextResponse.json({ inserted_count: prepared.length });
}
