// Shared helpers for k6 scenarios.
import http from "k6/http";
import { check } from "k6";

export const BASE = __ENV.API_BASE_URL || "http://127.0.0.1:8787";

/** Tokens: TOKENS_FILE (local, minted) or Supabase password sign-in (staging). */
export function loadUsers() {
  if (__ENV.TOKENS_FILE) return JSON.parse(open(__ENV.TOKENS_FILE));
  return null;
}

export function signInUsers(count) {
  const users = [];
  for (let n = 1; n <= count; n++) {
    const email = `user${String(n).padStart(3, "0")}@conime.test`;
    const r = http.post(`${__ENV.SUPABASE_URL}/auth/v1/token?grant_type=password`,
      JSON.stringify({ email, password: __ENV.TEST_PASSWORD }),
      { headers: { "content-type": "application/json", apikey: __ENV.SUPABASE_ANON_KEY } });
    if (r.status === 200) users.push({ user_id: r.json("user.id"), token: r.json("access_token") });
  }
  return users;
}

export function auth(token, extra = {}) {
  return { headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra } };
}

export function ok(res, name, statuses = [200]) {
  return check(res, { [`${name} status`]: (r) => statuses.includes(r.status) });
}

export function uuid() {
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
}
