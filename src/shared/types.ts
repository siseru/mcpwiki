// Domain types shared by backend, web, and CLI.

export const ROLES = ['admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Who can read an article (in addition to admins, who can always read). */
export const READ_SCOPES = ['admin', 'owner', 'all'] as const;
export type ReadScope = (typeof READ_SCOPES)[number];

/** Who can edit an article. `none` = read-only (admins can still edit). */
export const WRITE_SCOPES = ['none', 'admin', 'owner', 'all'] as const;
export type WriteScope = (typeof WRITE_SCOPES)[number];

/** OKF `status` values. */
export const STATUSES = ['draft', 'stable', 'deprecated'] as const;
export type Status = (typeof STATUSES)[number];

/** Channel an operation came through (recorded in audit/history). */
export type Via = 'web' | 'cli' | 'mcp' | 'api';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface Principal {
  sub: string;
  username: string;
  role: Role;
  clientId: string;
  via: Via;
  /** Seconds since epoch, from the token. */
  issuedAt: number;
}

export interface ArticleMeta {
  id: string;
  /** OKF `type`. Defaults to "Wiki Article". */
  type: string;
  title: string;
  description: string;
  tags: string[];
  status: Status;
  readScope: ReadScope;
  writeScope: WriteScope;
  owner: string; // Cognito sub
  ownerName: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string; // username
  /** OKF `generated.by` actor of the latest revision. */
  generatedBy: string;
  /** OKF `verified` entries. */
  verified: { by: string; at: string }[];
  /** OKF extension keys preserved verbatim. */
  extra: Record<string, JsonValue>;
  /** Outgoing links to other article ids. */
  links: string[];
  s3VersionId: string;
  deleted: boolean;
  deletedAt?: string;
  deletedBy?: string;
}

export interface Article extends ArticleMeta {
  body: string;
}

/** Fields a client may supply when creating/updating. */
export interface ArticleInput {
  id?: string;
  type?: string;
  title?: string;
  description?: string;
  tags?: string[];
  status?: Status;
  readScope?: ReadScope;
  writeScope?: WriteScope;
  body?: string;
  extra?: Record<string, JsonValue>;
}

export interface HistoryEntry {
  id: string;
  version: number;
  s3VersionId: string;
  title: string;
  updatedAt: string;
  updatedBy: string;
  via: Via;
  action: 'create' | 'update' | 'delete' | 'restore' | 'verify' | 'import';
  /** readScope the revision was written with (absent on old entries => treated as owner-only). */
  readScope?: ReadScope;
}

export interface AuditEntry {
  ts: string;
  actor: string;
  sub: string;
  via: Via;
  action: string;
  articleId?: string;
  detail?: string;
}

/** Public, client-safe summary of an article. */
export interface ArticleSummary {
  id: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  status: Status;
  readScope: ReadScope;
  writeScope: WriteScope;
  ownerName: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  canEdit: boolean;
  deleted?: boolean;
}

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  tags: string[];
  status: Status;
  updatedAt: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'link' | 'tag';
  /** For `tag` edges, the shared tags. */
  tags?: string[];
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

/** Runtime configuration published to browsers / CLI at /config.json. */
/** Wiki-wide settings editable by admins. */
export interface SiteSettings {
  title: string;
}

export const DEFAULT_SITE_TITLE = 'MCPWiki';

export interface PublicConfig {
  env: string;
  region: string;
  cognitoDomain: string; // e.g. https://xxx.auth.us-west-2.amazoncognito.com
  webClientId: string;
  cliClientId: string;
  cliRedirectUri: string;
  issuer: string;
}

/** File attached to an article. Access follows the article's read/write scopes. */
export interface Attachment {
  articleId: string;
  fileId: string;
  name: string;
  contentType: string;
  size: number;
  status: 'pending' | 'ready' | 'rejected';
  uploadedBy: string; // username
  uploadedBySub: string;
  uploadedAt: string;
  deleted?: boolean;
}
