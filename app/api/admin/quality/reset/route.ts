import { NextResponse } from "next/server";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN ?? "";

function requireEnv(key: string, value: string) {
  if (!value) throw new Error(`${key} missing`);
}

async function pgFetch(path: string, init: RequestInit) {
  requireEnv("SUPABASE_URL", SUPABASE_URL);
  requireEnv("SERVICE_KEY", SERVICE_KEY);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`pgFetch failed ${res.status} ${await res.text()}`);
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  requireEnv("ADMIN_TOKEN", ADMIN_TOKEN);
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1) delete all jobs
  await pgFetch("jobs", { method: "DELETE" });

  // 2) reset job_import migrated_at to null
  await pgFetch("job_import?migrated_at=not.is.null", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ migrated_at: null }),
  });

  return NextResponse.json({ ok: true });
}
