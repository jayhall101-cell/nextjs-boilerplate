import { NextResponse } from "next/server";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;

type Body =
  | { token: string; action: "complaint"; job_id: number; complaint: boolean }
  | { token: string; action: "deduction"; job_id: number; deduction: number }
  | { token: string; action: "run_import" };

async function callRpc(rpcName: string, payload: object) {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error("Server env vars missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`RPC ${rpcName} failed: ${res.status}`);
  return res.json();
}

export async function POST(req: Request) {
  const body = (await req.json()) as Body;

  if (!ADMIN_TOKEN || body.token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (body.action === "complaint") {
    await callRpc("rpc_set_job_complaint", { p_job_id: body.job_id, p_complaint: body.complaint });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "deduction") {
    await callRpc("rpc_set_quality_deduction", { p_job_id: body.job_id, p_deduction: body.deduction });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "run_import") {
    const result = await callRpc("rpc_run_job_import", {});
    return NextResponse.json({ inserted_count: (result?.[0] as any)?.rpc_run_job_import ?? 0 });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
