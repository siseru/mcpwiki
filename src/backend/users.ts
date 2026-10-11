// User administration (Cognito) behind a small interface.
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  UserNotFoundException,
  UsernameExistsException,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Role } from '../shared/types.js';
import { ROLES } from '../shared/types.js';
import { ConflictError, HttpError } from './errors.js';

export interface UserInfo {
  username: string;
  sub: string;
  email: string;
  enabled: boolean;
  status: string;
  role: Role | null;
  createdAt: string;
}

export interface UserDirectory {
  list(): Promise<UserInfo[]>;
  get(username: string): Promise<UserInfo | null>;
  /** Throws ConflictError if the username exists. */
  invite(username: string, email: string, role: Role): Promise<UserInfo>;
  setRole(username: string, role: Role): Promise<void>;
  setEnabled(username: string, enabled: boolean): Promise<void>;
  /**
   * Lets the user's passkeys satisfy MFA (TOTP stays as a fallback). Only possible after the user registered a
   * passkey; otherwise HttpError 409 no_passkey.
   */
  enablePasskeyMfa(username: string): Promise<void>;
}

function attr(u: Pick<UserType, 'Attributes'>, name: string): string {
  return u.Attributes?.find((a) => a.Name === name)?.Value ?? '';
}

export class CognitoUserDirectory implements UserDirectory {
  private readonly c: CognitoIdentityProviderClient;
  constructor(private readonly poolId: string, region?: string) {
    this.c = new CognitoIdentityProviderClient({ region });
  }

  private async groupMembers(): Promise<Map<string, Role>> {
    const roles = new Map<string, Role>();
    // ROLES is ordered highest first; keep the highest role per user.
    for (const role of ROLES) {
      let token: string | undefined;
      do {
        const res = await this.c.send(new ListUsersInGroupCommand({ UserPoolId: this.poolId, GroupName: role, NextToken: token }));
        for (const u of res.Users ?? []) if (u.Username && !roles.has(u.Username)) roles.set(u.Username, role);
        token = res.NextToken;
      } while (token);
    }
    return roles;
  }

  async list(): Promise<UserInfo[]> {
    const roles = await this.groupMembers();
    const out: UserInfo[] = [];
    let token: string | undefined;
    do {
      const res = await this.c.send(new ListUsersCommand({ UserPoolId: this.poolId, PaginationToken: token }));
      for (const u of res.Users ?? []) {
        out.push({
          username: u.Username ?? '',
          sub: attr(u, 'sub'),
          email: attr(u, 'email'),
          enabled: u.Enabled ?? false,
          status: u.UserStatus ?? '',
          role: roles.get(u.Username ?? '') ?? null,
          createdAt: u.UserCreateDate?.toISOString() ?? '',
        });
      }
      token = res.PaginationToken;
    } while (token && out.length < 5000);
    return out.sort((a, b) => a.username.localeCompare(b.username));
  }

  async get(username: string): Promise<UserInfo | null> {
    try {
      const u = await this.c.send(new AdminGetUserCommand({ UserPoolId: this.poolId, Username: username }));
      const roles = await this.groupMembers();
      return {
        username: u.Username ?? username,
        sub: u.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? '',
        email: u.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '',
        enabled: u.Enabled ?? false,
        status: u.UserStatus ?? '',
        role: roles.get(u.Username ?? username) ?? null,
        createdAt: u.UserCreateDate?.toISOString() ?? '',
      };
    } catch (e) {
      if (e instanceof UserNotFoundException) return null;
      throw e;
    }
  }

  async invite(username: string, email: string, role: Role): Promise<UserInfo> {
    try {
      await this.c.send(
        new AdminCreateUserCommand({
          UserPoolId: this.poolId,
          Username: username,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
          DesiredDeliveryMediums: ['EMAIL'],
        }),
      );
    } catch (e) {
      if (e instanceof UsernameExistsException) throw new ConflictError('user exists');
      throw e;
    }
    await this.c.send(new AdminAddUserToGroupCommand({ UserPoolId: this.poolId, Username: username, GroupName: role }));
    return (await this.get(username))!;
  }

  async setRole(username: string, role: Role): Promise<void> {
    await this.c.send(new AdminAddUserToGroupCommand({ UserPoolId: this.poolId, Username: username, GroupName: role }));
    for (const r of ROLES) {
      if (r !== role) await this.c.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: this.poolId, Username: username, GroupName: r }));
    }
    await this.c.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.poolId, Username: username }));
  }

  async setEnabled(username: string, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.c.send(new AdminEnableUserCommand({ UserPoolId: this.poolId, Username: username }));
    } else {
      await this.c.send(new AdminDisableUserCommand({ UserPoolId: this.poolId, Username: username }));
      await this.c.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.poolId, Username: username }));
    }
  }

  async enablePasskeyMfa(username: string): Promise<void> {
    // Cognito's rules, verified against a real user pool (2026-10):
    // - passkey MFA needs a registered passkey ("does not have applicable WebAuthn credentials");
    // - and another MFA method enabled IN THE SAME REQUEST ("requires enabling an additional MFA setting"):
    //   TOTP enabled by an earlier call, even as preferred, does not count. In an MFA-required pool the TOTP a
    //   user sets up at first sign-in is in use but not recorded as an enabled preference, so it is declared
    //   here. Omitting PreferredMfa clears an existing TOTP preference; verified harmless: password sign-in
    //   still goes straight to the TOTP code, and passkey sign-in needs no second factor.
    try {
      await this.c.send(
        new AdminSetUserMFAPreferenceCommand({
          UserPoolId: this.poolId,
          Username: username,
          SoftwareTokenMfaSettings: { Enabled: true },
          WebAuthnMfaSettings: { Enabled: true },
        }),
      );
    } catch (e) {
      const name = (e as { name?: string }).name;
      const message = String((e as Error).message);
      if (name === 'InvalidParameterException' && /WebAuthn credentials/i.test(message)) {
        throw new HttpError(409, 'no_passkey', 'no passkey is registered for this account yet');
      }
      if (name === 'InvalidParameterException' && /software token/i.test(message)) {
        throw new HttpError(409, 'totp_required', 'set up the authenticator app (TOTP) first; it stays the fallback for passkeys');
      }
      throw e;
    }
  }
}

/** In-memory directory for tests. */
export class MemoryUserDirectory implements UserDirectory {
  users = new Map<string, UserInfo>();
  async list() {
    return [...this.users.values()];
  }
  async get(username: string) {
    return this.users.get(username) ?? null;
  }
  async invite(username: string, email: string, role: Role) {
    if (this.users.has(username)) throw new ConflictError('user exists');
    const u: UserInfo = { username, sub: `sub-${username}`, email, enabled: true, status: 'FORCE_CHANGE_PASSWORD', role, createdAt: new Date().toISOString() };
    this.users.set(username, u);
    return u;
  }
  async setRole(username: string, role: Role) {
    this.users.get(username)!.role = role;
  }
  async setEnabled(username: string, enabled: boolean) {
    this.users.get(username)!.enabled = enabled;
  }
  passkeyMfa = new Set<string>();
  /** Users that have registered a passkey (Cognito refuses passkey MFA before that). */
  passkeys = new Set<string>();
  async enablePasskeyMfa(username: string) {
    if (!this.passkeys.has(username)) throw new HttpError(409, 'no_passkey', 'no passkey is registered for this account yet');
    this.passkeyMfa.add(username);
  }
}
