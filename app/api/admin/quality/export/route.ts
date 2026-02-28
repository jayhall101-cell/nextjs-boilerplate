import { NextResponse } from "next/server";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;

function assertEnv() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Supabase env vars missing");
}

async function pgGet(path: string, query: URLSearchParams) {
  assertEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${query.toString()}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`PostgREST GET ${path} failed: ${res.status}`);
  return res.json();
}

function toCsv(rows: any[]) {
  const headers = [
    "date",
    "technician",
    "job_type",
    "points",
    "complaint_flag",
    "quality_deduction",
    "net_points",
  ];
  const escape = (v: any) => {
    const s = v === null || v === undefined ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    const net = Number(r.points ?? 0) - Number(r.quality_deduction ?? 0);
    lines.push(
      [
        r.job_date,
        r.technician_name ?? "",
        r.job_type,
        r.points,
        r.complaint_flag,
        r.quality_deduction,
        net,
      ].map(escape).join(",")
    );
  }
  return lines.join("\n");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!ADMIN_TOKEN || url.searchParams.get("token") !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = new URLSearchParams();
  q.set(
    "select",
    "id,technician_id,job_type,job_date:date,points,complaint_flag,quality_deduction"
  );
  q.set("order", "date.desc");
  q.set("limit", url.searchParams.get("limit") ?? "2000");

  const technicianId = url.searchParams.get("technician_id");
  if (technicianId) q.set("technician_id", `eq.${technicianId}`);

  const start = url.searchParams.get("start_date");
  const end = url.searchParams.get("end_date");
  if (start) q.append("date", `gte.${start}`);
  if (end) q.append("date", `lte.${end}`);

  const technicians = await pgGet("technicians", new URLSearchParams({ select: "id,name" }));
  const techById = new Map<number, string>();
  for (const t of technicians) techById.set(Number(t.id), t.name);

  const jobs = await pgGet("jobs", q);
  const rows = jobs.map((j: any) => ({
    ...j,
    technician_name: techById.get(Number(j.technician_id)) ?? "",
  }));

  const csv = toCsv(rows);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=quality_export.csv",
    },
  });
}
