/**
 * Wire types for Greasy Fork's read-only JSON API.
 *
 * They mirror the server payloads exactly (snake_case field names) so responses
 * can be handed straight to consumers without a translation layer.
 */

export interface User {
  id: number;
  name: string;
  created_at: string;
  url: string;
}

/**
 * One Greasy Fork script record. Search results and the
 * `/scripts/<id>-<slug>.json` detail endpoint return the same shape, so a single
 * type serves both.
 */
export interface Script {
  id: number;
  daily_installs: number;
  total_installs: number;
  /** The server sends this as a string ("88.6"); typed loosely on purpose. */
  fan_score?: string | number | null;
  good_ratings: number;
  ok_ratings: number;
  bad_ratings: number;
  created_at: string;
  code_updated_at: string;
  namespace: string | null;
  support_url: string | null;
  contribution_url: string | null;
  users: User[];
  name: string;
  description: string | null;
  url: string;
  code_url: string | null;
  code_size: number;
  license: string | null;
  version: string;
  locale: string;
  deleted: boolean;
}

/** The query the server actually executed — useful to confirm a param landed. */
export interface SearchEcho {
  fields?: string[];
  boost_by?: string[];
  where?: Record<string, unknown>;
  order?: Record<string, string>;
  page?: number;
  per_page?: number;
}

/** Envelope returned by `scripts.json`. */
export interface SearchResult {
  model: string;
  term: string | null;
  options: SearchEcho;
  query: Script[];
  /**
   * The server sends an ARRAY of search terms here. Typed `unknown` on purpose:
   * declaring it `string` makes the whole response fail to parse.
   */
  execute: unknown;
}

/** One historical release of a script. */
export interface ScriptVersion {
  version: string;
  created_at: string;
  url: string;
  code_url: string;
  changelog?: string | null;
}

/** Returned by `/<locale>/users/<id|slug>.json`. */
export interface UserDetail {
  id: number;
  name: string;
  created_at: string;
  url: string;
  scripts: Script[];
}

/**
 * Friendly sort name → the value the API expects. An empty value means "let the
 * server decide" (relevance when a query is present, daily installs otherwise).
 */
export const SORT_KEYS = {
  relevant: '',
  daily: '',
  installs: 'installs',
  created: 'created',
  updated: 'updated',
  rating: 'rating',
  name: 'name',
} as const;

export type SortName = keyof typeof SORT_KEYS;

/** Sort names in a stable, alphabetical order (for help text). */
export const SORT_NAMES: SortName[] = Object.keys(SORT_KEYS).sort() as SortName[];
