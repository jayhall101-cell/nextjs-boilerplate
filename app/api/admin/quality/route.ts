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
      ...((init?.headers ?? {}) as Record<string, string>),
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...((init?.method?.toUpperCase() === "POST" || init?.method?.toUpperCase() === "PATCH")
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
  const res = await pgFetch(path, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { Prefer: "return=representation" },
  });
  return res.json();
}

async function pgInsert(path: string, body: any) {
  const res = await pgFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { Prefer: "return=representation" },
  });
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

  if (!body.token || body.token !== ADMIN_TOKEN) {
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

  // run_import: reset to match CSV staging, then import once
  await pgFetch("jobs", { method: "DELETE" });
  await pgPatch("job_import?migrated_at=not.is.null", { migrated_at: null });

  const imports = await pgGet<any[]>(
    'job_import?migrated_at=is.null&select=Status,Date,"Assigned user",Client,Title'
  );

  const jobTypes = await pgGet<{ id: number; job_name: string; point_value: number }[]>(
    "job_types?select=id,job_name,point_value"
  );

  const technicians = await pgGet<{ id: number; name: string }[]>(
    "technicians?select=id,name"
  );

  const quarters = await pgGet<{ id: number; start_date: string; end_date: string }[]>(
    "quarters?select=id,start_date,end_date"
  );

  const jobTypeById = new Map<number, { name: string; points: number }>();
  const pointsByCode = new Map<string, number>();
  for (const jt of jobTypes) {
    const code = normalizeJobType(jt.job_name);
    jobTypeById.set(jt.id, { name: jt.job_name, points: jt.point_value });
    pointsByCode.set(code, jt.point_value);
  }

  const techIdByName = new Map<string, number>();
  for (const t of technicians) techIdByName.set((t.name ?? "").trim(), t.id);

  const prepared: any[] = [];

  for (const row of imports) {
    const techId = techIdByName.get(String(row["Assigned user"] ?? "").trim());
    const jt = jobTypeById.get(Number(row.Status));

    if (!techId || !jt) continue;

    const rowDate = String(row.Date ?? "");
    const q = quarters.find(
      (qq) => rowDate >= String(qq.start_date) && rowDate <= String(qq.end_date)
    );
    if (!q) continue;

    const jobCode = normalizeJobType(jt.name);
    const points = pointsByCode.get(jobCode) ?? jt.points;

    prepared.push({
      technician_id: techId,
      quarter_id: q.id,
      date: toDay(rowDate),
      job_type: jobCode,
      points,
      complaint_flag: false,
      quality_deduction: 0,
    });
  }

  if (prepared.length) await pgInsert("jobs", prepared);
  await pgPatch("job_import?migrated_at=is.null", { migrated_at: new Date().toISOString() });

  return NextResponse.json({ ok: true });
}
