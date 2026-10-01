// Samples queue backlog and database connection usage during a load test.
//   deno run -A scripts/load-monitor.ts 120 > tests/load/results/monitor.csv   (seconds)
import postgres from "postgres";
const seconds = Number(Deno.args[0] ?? "120");
const sql = postgres(Deno.env.get("CONIME_DB_URL") ?? Deno.env.get("SUPABASE_DB_URL")!, { max: 1, onnotice: () => {} });
console.log("ts,connections_total,connections_active,queue_length,oldest_msg_age_sec,jobs_pending,jobs_failed");
for (let i = 0; i < seconds; i++) {
  const [c] = await sql`select count(*)::int as total, count(*) filter (where state = 'active')::int as active from pg_stat_activity where datname = current_database()`;
  const [q] = await sql`select queue_length::int, coalesce(oldest_msg_age_sec, 0)::int as age from pgmq.metrics('ai_jobs')`;
  const [j] = await sql`select count(*) filter (where status not in ('completed','failed','superseded'))::int as pending, count(*) filter (where status = 'failed')::int as failed from app.ai_jobs`;
  console.log([new Date().toISOString(), c.total, c.active, q.queue_length, q.age, j.pending, j.failed].join(","));
  await new Promise((r) => setTimeout(r, 1000));
}
await sql.end();
