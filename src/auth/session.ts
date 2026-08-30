import { createHash, randomBytes } from "node:crypto";

import { cookies } from "next/headers";

import { getDatabase } from "@/db";

const SESSION_COOKIE = "sydaris_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1_000;

export type AuthPrincipal = {
  userId: string;
  loginName: string;
  role: "ADMIN" | "MEMBER";
  actor: {
    id: string;
    displayName: string;
  };
  actorObject: {
    id: string;
    canonicalName: string;
  } | null;
};

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function principalFromSession(session: {
  user: {
    id: string;
    loginName: string;
    role: "ADMIN" | "MEMBER";
    actor: { id: string; displayName: string };
    actorObject: {
      id: string;
      canonicalName: string;
    } | null;
  };
}): AuthPrincipal {
  return {
    userId: session.user.id,
    loginName: session.user.loginName,
    role: session.user.role,
    actor: session.user.actor,
    actorObject: session.user.actorObject
      ? {
          id: session.user.actorObject.id,
          canonicalName: session.user.actorObject.canonicalName,
        }
      : null,
  };
}

export async function currentAuthUser(): Promise<AuthPrincipal | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const now = new Date();
  const database = getDatabase();
  const session = await database.authSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    select: {
      id: true,
      expiresAt: true,
      lastSeenAt: true,
      user: {
        select: {
          id: true,
          loginName: true,
          role: true,
          status: true,
          actor: { select: { id: true, displayName: true } },
          actorObject: {
            select: {
              id: true,
              canonicalName: true,
            },
          },
        },
      },
    },
  });
  if (!session || session.expiresAt <= now || session.user.status !== "ACTIVE") {
    if (session) await database.authSession.deleteMany({ where: { id: session.id } });
    return null;
  }
  if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
    await database.authSession.update({
      where: { id: session.id },
      data: { lastSeenAt: now },
    });
  }
  return principalFromSession(session);
}

export async function createAuthSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getDatabase().authSession.create({
    data: { userId, tokenHash: tokenHash(token), expiresAt },
  });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function revokeCurrentSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    await getDatabase().authSession.deleteMany({
      where: { tokenHash: tokenHash(token) },
    });
  }
  cookieStore.delete(SESSION_COOKIE);
}

export function unauthorizedResponse(): Response {
  return Response.json({ error: "请先登录。" }, { status: 401 });
}

export function forbiddenResponse(): Response {
  return Response.json({ error: "当前账号没有此操作权限。" }, { status: 403 });
}
