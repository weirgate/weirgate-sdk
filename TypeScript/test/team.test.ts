// Team members and invitations (weirgate#289, #290, #291) and the step-up refusal (weirgate#292).
// These routes accept only a dashboard sign-in (a Clerk session token), never an admin key.
import { describe, expect, it, vi } from "vitest";
import {
  API_VERSION,
  ResourceConflictError,
  StepUpRequiredError,
  Weirgate,
  WeirgateError,
  type DeveloperMember,
  type UserListPage,
} from "../src/index.js";

const responseHeaders = {
  "Weirgate-Api-Version": API_VERSION,
  "X-Weirgate-Request-Id": "req_12345678",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    ...init,
    headers: { "Content-Type": "application/json", ...responseHeaders, ...init.headers },
  });
}

function errorResponse(status: number, type: string, detail: Record<string, unknown>, message = "refused"): Response {
  return jsonResponse(
    { error: { type, message, request_id: "req_12345678", detail } },
    { status, headers: { "X-Weirgate-Error-Type": type } },
  );
}

const member: DeveloperMember = {
  id: "dev_2",
  auth_subject: "user_2",
  role: "member",
  created_at: "2026-10-01T00:00:00.000Z",
  last_seen_at: "2026-10-28T00:00:00.000Z",
};

function client(fetch: typeof globalThis.fetch, sessionToken: string | (() => Promise<string>) = "sess_token") {
  return new Weirgate({ appId: "app_1", adminKey: "wgk_admin", sessionToken, fetch });
}

function sent(fetch: ReturnType<typeof vi.fn>, call = 0): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetch.mock.calls[call] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

describe("team members", () => {
  it("lists members with the session token, never the admin key or app id", async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: [member] }));
    const result = await client(fetch, async () => "sess_fresh").listMembers();

    expect(result.data.data).toEqual([member]);
    const { url, init, headers } = sent(fetch);
    expect(url).toBe("https://api.weirgate.com/v1/admin/members");
    expect(init.method).toBe("GET");
    expect(headers.get("Authorization")).toBe("Bearer sess_fresh");
    expect(headers.has("X-Admin-Key")).toBe(false);
    expect(headers.has("X-App-Id")).toBe(false);
  });

  it("requires sessionToken before sending anything", async () => {
    const fetch = vi.fn();
    const weirgate = new Weirgate({ adminKey: "wgk_admin", fetch });
    await expect(weirgate.listMembers()).rejects.toThrow(TypeError);
    await expect(weirgate.removeMember("dev_2")).rejects.toThrow(/sessionToken is required/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("changes a role with PATCH and an idempotency key", async () => {
    const fetch = vi.fn(async () => jsonResponse({ ...member, role: "owner" }));
    const result = await client(fetch).updateMemberRole("dev/2", "owner");

    expect(result.data.role).toBe("owner");
    const { url, init, headers } = sent(fetch);
    expect(url).toBe("https://api.weirgate.com/v1/admin/members/dev%2F2");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ role: "owner" });
    expect(headers.get("X-Idempotency-Key")).toBeTruthy();
  });

  it("removes a member and reports an already absent Clerk membership", async () => {
    const fetch = vi.fn(async () => jsonResponse({ id: "dev_2", removed: true, clerk_membership: "already_absent" }));
    const result = await client(fetch).removeMember("dev_2");

    expect(result.data).toEqual({ id: "dev_2", removed: true, clerk_membership: "already_absent" });
    expect(sent(fetch).init.method).toBe("DELETE");
    expect(sent(fetch).init.body).toBeUndefined();
  });

  it("maps last_owner to ResourceConflictError", async () => {
    const fetch = vi.fn(async () => errorResponse(409, "resource_conflict", { reason: "last_owner" }));
    const error = await client(fetch).updateMemberRole("dev_1", "member").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResourceConflictError);
    expect((error as ResourceConflictError).detail).toEqual({ reason: "last_owner" });
  });
});

describe("team invitations", () => {
  it("invites an address", async () => {
    const fetch = vi.fn(async () => jsonResponse({ id: "orginv_1", status: "pending", role: "member" }, { status: 201 }));
    const result = await client(fetch).createInvitation("new@example.com");

    expect(result.status).toBe(201);
    expect(result.data).toEqual({ id: "orginv_1", status: "pending", role: "member" });
    const { url, init, headers } = sent(fetch);
    expect(url).toBe("https://api.weirgate.com/v1/admin/invitations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email_address: "new@example.com" });
    expect(headers.get("Authorization")).toBe("Bearer sess_token");
  });

  it("revokes an invitation by its Clerk id", async () => {
    const fetch = vi.fn(async () => jsonResponse({ id: "orginv_1", status: "revoked", already_revoked: true }));
    const result = await client(fetch).revokeInvitation("orginv_1");

    expect(result.data.already_revoked).toBe(true);
    expect(sent(fetch).url).toBe("https://api.weirgate.com/v1/admin/invitations/orginv_1/revoke");
    expect(sent(fetch).init.method).toBe("POST");
  });
});

describe("step-up refusal", () => {
  it("is a StepUpRequiredError with the level to verify", async () => {
    const fetch = vi.fn(async () => errorResponse(
      403,
      "insufficient_scope",
      { reason: "step_up_required", level: "first_factor", max_age_minutes: 10 },
      "recent sign-in verification required",
    ));
    const error = await client(fetch).removeMember("dev_2").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StepUpRequiredError);
    expect(error).toBeInstanceOf(WeirgateError);
    const stepUp = error as StepUpRequiredError;
    expect(stepUp.type).toBe("insufficient_scope");
    expect(stepUp.status).toBe(403);
    expect(stepUp.level).toBe("first_factor");
    expect(stepUp.maxAgeMinutes).toBe(10);
    expect(stepUp.message).toBe("recent sign-in verification required");
  });

  it("leaves other insufficient_scope refusals as WeirgateError", async () => {
    const fetch = vi.fn(async () => errorResponse(403, "insufficient_scope", { reason: "owner_required" }));
    const error = await client(fetch).createInvitation("new@example.com").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WeirgateError);
    expect(error).not.toBeInstanceOf(StepUpRequiredError);
  });
});

describe("sandbox users in listUsers", () => {
  it("sends the origin filter and reads sandbox_total", async () => {
    const page: UserListPage = {
      data: [],
      pagination: { limit: 100, returned: 0, truncated: false, next_cursor: null, total: 0, sandbox_total: 3, total_capped: false },
    };
    const fetch = vi.fn(async () => jsonResponse(page));
    const result = await new Weirgate({ adminKey: "wgk_admin", fetch }).listUsers("app_1", { origin: "sandbox" });

    expect(sent(fetch).url).toBe("https://api.weirgate.com/v1/admin/apps/app_1/users?origin=sandbox");
    expect(sent(fetch).headers.get("X-Admin-Key")).toBe("wgk_admin");
    expect(result.data.pagination.sandbox_total).toBe(3);
  });
});
