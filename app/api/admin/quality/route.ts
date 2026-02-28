import { NextResponse } from "next/server";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;

type Body =
  | { token: string; action: "complaint"; job_id: number; complaint: boolean }
  | { token: string; action: "deduction"; job_id: number; deduction: number }
  | { token: string; action: "run_import" };

function requireEnv() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Missing server env vars (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }
}

function jsonHeaders(): HeadersInit {
  return {
    apikey: SERVICE_KEY!,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

async function pgGet<T>(path: string): Promise<T> {
  requireEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "GET",
    headers: jsonHeaders(),
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function pgPatch(path: string, payload: object) {
  requireEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status} ${await res.text()}`);
  await res.json().catch(() => undefined);
}

async function pgInsert(path: string, payload: object | object[]) {
  requireEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function toDay(date: string) {
  return new Date(date).toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!ADMIN_TOKEN || body.token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    if (body.action === "complaint") {
      await pgPatch(`jobs?id=eq.${body.job_id}`, { complaint_flag: body.complaint });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "deduction") {
      const deduction = Math.max(0, Math.round(body.deduction));
      await pgPatch(`jobs?id=eq.${body.job_id}`, { quality_deduction: deduction });
      return NextResponse.json({ ok: true });
    }

    // run_import
    const imports = await pgGet<any[]>(
      'job_import?migrated_at=is.null&select=id,"Status","Date","Assigned user","Client","Title"'
    );

    if (!imports.length) {
      return NextResponse.json({ inserted_count: 0 });
    }

    const jobTypes = await pgGet<any[]>("job_types?select=id,job_name,point_value");
    const technicians = await pgGet<any[]>("technicians?select=id,name");
    const quarters = await pgGet<any[]>("quarters?select=id,start_date,end_date");

    const jobTypeByStatus = new Map<number, any>();
    for (const jt of jobTypes) jobTypeByStatus.set(Number(jt.id), jt);

    const technicianByName = new Map<string, any>();
    for (const t of technicians) technicianByName.set(String(t.name).trim(), t);

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

      prepared.push({
        technician_id: tech.id,
        quarter_id: q.id,
        date: toDay(row.Date),
        job_type: jt.job_name,
        points: jt.point_value,
        complaint_flag: false,
        quality_deduction: 0,
      });
    }

    if (!prepared.length) {
      return NextResponse.json({ inserted_count: 0 });
    }

    await pgInsert("jobs", prepared);

    const ids = imports.map((r) => r.id).join(",");
    await pgPatch(`job_import?id=in.(${ids})`, { migrated_at: new Date().toISOString() });

    return NextResponse.json({ inserted_count: prepared.length });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
