import { NextResponse } from "next/server";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN ?? "";

type Body =
  | { token: string; action: "complaint"; job_id: number; complaint: boolean }
  | { token: string; action: "deduction"; job_id: number; deduction: number }
  | { token: string; action: "run_import" };

function normalizeJobType(raw: any) {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function authHeaders(): Record<string, string> {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Missing server env vars (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

async function pgFetch(path: string, init: RequestInit) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, init);
  if (!res.ok) {
    throw new Error(`PostgREST error: ${res.status}`);
  }

  // Some operations return 204 No Content
  if (res.status === 204) {
    return null;
  }

  const text = await res.text();
  if (!text) return null;

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text as any;
  }
}

function pgGet<T>(path: string) {
  return pgFetch(path, { method: "GET", headers: authHeaders() }) as Promise<T>;
}

function pgPatch(path: string, body: Record<string, any>) {
  return pgFetch(path, { method: "PATCH", headers: authHeaders(), body: JSON.stringify(body) });
}

function pgInsert(path: string, body: any) {
  return pgFetch(path, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
}

function toDay(raw: any) {
  // safe conversion for date-only column
  return new Date(raw).toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;

  if (!body.token || body.token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (body.action === "complaint") {
    await pgPatch(`jobs?id=eq.${body.job_id}`, { complaint_flag: body.complaint });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "deduction") {
    await pgPatch(`jobs?id=eq.${body.job_id}`, { quality_deduction: body.deduction });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "run_import") {
    // Full reset to avoid duplicates
    await pgFetch("jobs", { method: "DELETE", headers: authHeaders() });
    await pgPatch("job_import?migrated_at=not.is.null", { migrated_at: null });

    const jobTypes = (await pgGet<Array<{ id: number; job_name: string; point_value?: number }>>("job_types")) ?? [];
    const jobTypeById = new Map<number, { job_name: string; point_value?: number }>();
    const pointsByNormalized = new Map<string, number>();

    for (const jt of jobTypes) {
      jobTypeById.set(jt.id, { job_name: jt.job_name, point_value: jt.point_value });
      pointsByNormalized.set(normalizeJobType(jt.job_name), jt.point_value ?? 0);
    }

    const technicians = (await pgGet<Array<{ id: number; name: string }>>("technicians")) ?? [];
    const techIdByName = new Map<string, number>();
    for (const t of technicians) techIdByName.set(String(t.name ?? "").trim(), t.id);

    const quarters =
      (await pgGet<Array<{ id: number; start_date: string; end_date: string }>>("quarters")) ?? [];

    const rows =
      (await pgGet<Array<{ Status: number; Date: string; "Assigned user": string; Client: string; Title: string }>>(
        'job_import?migrated_at=is.null&select=Status,Date,"Assigned user",Client,Title'
      )) ?? [];

    const prepared: Array<{ technician_id: number; quarter_id: number; date: string; job_type: string; points: number; complaint_flag: boolean; quality_deduction: number }> = [];

    for (const row of rows) {
      const jt = jobTypeById.get(row.Status);
      const jobTypeName = jt?.job_name ?? "";
      const jobTypeCode = normalizeJobType(jobTypeName);
      const points = pointsByNormalized.get(jobTypeCode) ?? 0;
      const technician = techIdByName.get(String(row["Assigned user"] ?? "").trim());

      const d = new Date(row.Date);
      const dateIso = toDay(d);

      let quarterId: number | undefined;
      for (const q of quarters) {
        const start = new Date(q.start_date);
        const end = new Date(q.end_date);
        if (d >= start && d <= end) {
          quarterId = q.id;
          break;
        }
      }

      if (!technician || !quarterId) continue;

      prepared.push({
        technician_id: technician,
        quarter_id: quarterId,
        date: dateIso,
        job_type: jobTypeCode,
        points,
        complaint_flag: false,
        quality_deduction: 0,
      });
    }

    if (prepared.length) {
      await pgInsert("jobs", prepared);
    }

    await pgPatch("job_import?migrated_at=is.null", { migrated_at: new Date().toISOString() });

    return NextResponse.json({ ok: true, inserted_count: prepared.length });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
