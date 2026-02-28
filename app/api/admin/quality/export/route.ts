import { NextResponse } from "next/server";

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN ?? "";

function assertEnv() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Supabase env vars missing");
}

async function pgGet(path: string, query: URLSearchParams) {
  assertEnv();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}?${query.toString()}`,
    {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    }
  );
  if (!res.ok) throw new Error(`PostgREST GET ${path} failed: ${res.status}`);
  return res.json();
}

function escapeCsv(v: unknown) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
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
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([
      escapeCsv(r.date),
      escapeCsv(r.technician),
      escapeCsv(r.job_type),
      escapeCsv(r.points),
      escapeCsv(r.complaint_flag),
      escapeCsv(r.quality_deduction),
      escapeCsv(r.net_points),
    ].join(","));
  }
  return lines.join("\n");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // filters
  const technicianId = url.searchParams.get("technician_id");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const technicians = await pgGet(
    "technicians",
    new URLSearchParams([["select", "id,name"]])
  );
  const techLookup = new Map<number, string>();
  for (const t of technicians as any[]) techLookup.set(t.id, t.name);

  const jobsQuery = new URLSearchParams();
  jobsQuery.set(
    "select",
    "id,technician_id,job_date:date,job_type,points,complaint_flag,quality_deduction"
  );
  jobsQuery.set("order", "date.desc");
  jobsQuery.set("limit", "5000");
  if (technicianId) jobsQuery.set("technician_id", "eq." + technicianId);
  if (from) jobsQuery.append("job_date", "gte." + from);
  if (to) jobsQuery.append("job_date", "lte." + to);

  const jobs = await pgGet("jobs", jobsQuery);
  const csvRows = (jobs as any[]).map((j) => ({
    date: j.job_date,
    technician: techLookup.get(j.technician_id) ?? j.technician_id,
    job_type: j.job_type,
    points: j.points,
    complaint_flag: j.complaint_flag,
    quality_deduction: j.quality_deduction,
    net_points: (j.points ?? 0) - (j.quality_deduction ?? 0),
  }));

  const csv = toCsv(csvRows);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=quality_export.csv",
    },
  });
}
