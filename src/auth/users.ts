import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { getDatabase } from "@/db";
import { hashPassword, normalizeLoginName } from "@/auth/credentials";
import { transactionAdvisoryLockQuery } from "@/db-advisory-lock";

export class AuthUserValidationError extends Error {
  constructor(message: string, readonly code = "INVALID_USER") {
    super(message);
    this.name = "AuthUserValidationError";
  }
}

export type CreateAuthUserInput = {
  loginName: string;
  displayName: string;
  password: string;
  role: "ADMIN" | "MEMBER";
  personObjectId?: string;
};

function cleanName(value: string, label: string): string {
  const cleaned = value.normalize("NFKC").trim();
  if (!cleaned || cleaned.length > 100) {
    throw new AuthUserValidationError(`${label}必须在 1 到 100 个字符之间。`);
  }
  return cleaned;
}

async function currentCompilation(database: Prisma.TransactionClient) {
  const compilation = await database.memoryCompilation.findFirst({
    orderBy: [{ importedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (!compilation) {
    throw new AuthUserValidationError(
      "当前尚无 Shared Brain Compilation，无法为登录人员建立 Person Object。",
      "NO_COMPILATION",
    );
  }
  return compilation;
}

async function resolvePersonObject(input: {
  database: Prisma.TransactionClient;
  compilationId: string;
  displayName: string;
  personObjectId?: string;
}) {
  if (input.personObjectId) {
    const selected = await input.database.memoryGlobalObject.findFirst({
      where: { id: input.personObjectId, compilationId: input.compilationId },
      select: { id: true, canonicalName: true },
    });
    if (!selected) {
      throw new AuthUserValidationError("选择的 Person Object 不存在于当前 Compilation。");
    }
    return selected;
  }

  const candidates = await input.database.memoryGlobalObject.findMany({
    where: {
      compilationId: input.compilationId,
      canonicalName: { equals: input.displayName, mode: "insensitive" },
    },
    orderBy: { id: "asc" },
    select: { id: true, canonicalName: true },
  });
  if (candidates.length > 1) {
    throw new AuthUserValidationError(
      [
        `当前存在 ${candidates.length} 个同名 Object，请确认后填写对应 Person Object ID：`,
        ...candidates.map((candidate) => `${candidate.canonicalName}（${candidate.id}）`),
      ].join("；"),
      "PERSON_AMBIGUOUS",
    );
  }
  if (candidates[0]) return candidates[0];

  const id = randomUUID();
  return input.database.memoryGlobalObject.create({
    data: {
      id,
      compilationId: input.compilationId,
      globalObjectKey: `account-person:${id}`,
      canonicalName: input.displayName,
    },
    select: { id: true, canonicalName: true },
  });
}

async function createUserInTransaction(
  database: Prisma.TransactionClient,
  input: CreateAuthUserInput,
  passwordHash: string,
) {
  const loginName = cleanName(input.loginName, "登录名");
  const displayName = cleanName(input.displayName, "真实姓名");
  const normalizedLoginName = normalizeLoginName(loginName);
  const compilation = await currentCompilation(database);
  await database.$queryRaw(transactionAdvisoryLockQuery(
    `auth-person-provision:${compilation.id}:${displayName.normalize("NFKC").toLocaleLowerCase("zh-CN")}`,
  ));
  const personObject = await resolvePersonObject({
    database,
    compilationId: compilation.id,
    displayName,
    personObjectId: input.personObjectId,
  });
  const alreadyLinked = await database.authUser.findUnique({
    where: { personObjectId: personObject.id },
    select: { id: true },
  });
  if (alreadyLinked) {
    throw new AuthUserValidationError("该 Person Object 已关联其他登录账号。");
  }

  const actorId = randomUUID();
  await database.memoryActor.create({
    data: { id: actorId, displayName },
  });
  const user = await database.authUser.create({
    data: {
      loginName,
      normalizedLoginName,
      passwordHash,
      role: input.role,
      actorId,
      personObjectId: personObject.id,
    },
    select: {
      id: true,
      loginName: true,
      role: true,
      status: true,
      actor: { select: { id: true, displayName: true } },
      personObject: { select: { id: true, canonicalName: true } },
    },
  });
  return user;
}

export async function createAuthUser(
  input: CreateAuthUserInput,
  database: PrismaClient = getDatabase(),
) {
  const passwordHash = await hashPassword(input.password);
  try {
    return await database.$transaction((transaction) =>
      createUserInTransaction(transaction, input, passwordHash)
    );
  } catch (error) {
    if (error instanceof AuthUserValidationError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AuthUserValidationError("登录名已存在。", "LOGIN_NAME_EXISTS");
    }
    throw error;
  }
}

export async function createInitialAdmin(
  input: Omit<CreateAuthUserInput, "role">,
  database: PrismaClient = getDatabase(),
) {
  const passwordHash = await hashPassword(input.password);
  return database.$transaction(async (transaction) => {
    await transaction.$queryRaw(transactionAdvisoryLockQuery("auth-initial-setup"));
    if (await transaction.authUser.count() > 0) {
      throw new AuthUserValidationError("系统已经完成初始化。", "ALREADY_INITIALIZED");
    }
    return createUserInTransaction(
      transaction,
      { ...input, role: "ADMIN" },
      passwordHash,
    );
  });
}

export async function authenticationSetupRequired(
  database: PrismaClient = getDatabase(),
): Promise<boolean> {
  return (await database.authUser.count()) === 0;
}

const authUserListSelect = {
  id: true,
  loginName: true,
  role: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  actor: { select: { id: true, displayName: true } },
  personObject: { select: { id: true, canonicalName: true } },
} as const;

export async function listAuthUsers(database: PrismaClient = getDatabase()) {
  return database.authUser.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    select: authUserListSelect,
  });
}

export async function updateAuthUser(input: {
  userId: string;
  actingUserId: string;
  password?: string;
  status?: "ACTIVE" | "DISABLED";
  role?: "ADMIN" | "MEMBER";
}, database: PrismaClient = getDatabase()) {
  const passwordHash = input.password ? await hashPassword(input.password) : undefined;
  return database.$transaction(async (transaction) => {
    const target = await transaction.authUser.findUnique({
      where: { id: input.userId },
      select: { id: true, role: true, status: true },
    });
    if (!target) throw new AuthUserValidationError("账号不存在。", "USER_NOT_FOUND");
    if (input.status === "DISABLED" && target.id === input.actingUserId) {
      throw new AuthUserValidationError("不能停用当前登录的管理员账号。");
    }
    const removesAdmin = target.role === "ADMIN" && (
      input.role === "MEMBER" || input.status === "DISABLED"
    );
    if (removesAdmin) {
      const otherActiveAdmins = await transaction.authUser.count({
        where: {
          id: { not: target.id },
          role: "ADMIN",
          status: "ACTIVE",
        },
      });
      if (!otherActiveAdmins) {
        throw new AuthUserValidationError("系统必须至少保留一个启用中的管理员。");
      }
    }
    const user = await transaction.authUser.update({
      where: { id: target.id },
      data: {
        ...(passwordHash ? { passwordHash } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.role ? { role: input.role } : {}),
      },
      select: authUserListSelect,
    });
    if (passwordHash || input.status === "DISABLED") {
      await transaction.authSession.deleteMany({ where: { userId: target.id } });
    }
    return user;
  });
}
