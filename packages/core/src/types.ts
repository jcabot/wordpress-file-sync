export type PostType = 'post' | 'page';

export type PostStatus = 'publish' | 'draft' | 'pending' | 'private' | 'future' | 'trash';

export interface Config {
  site_url: string;
  content_dir: string;
  enabled_types: PostType[];
  username: string;
}

export interface Credentials {
  username: string;
  password: string;
}

export interface State {
  schema_version: 1;
  last_sync: string | null;
}

export interface FrontMatter {
  id?: number;
  type: PostType;
  slug: string;
  title: string;
  status: PostStatus;
  parent?: number;
  categories?: string[];
  tags?: string[];
  featured_media: number;
  excerpt: string;
  date_gmt: string;
  modified_gmt: string;
}

export interface RestRendered {
  raw: string;
  rendered: string;
}

export interface RestItem {
  id: number;
  type: string;
  slug: string;
  status: string;
  date_gmt: string;
  modified_gmt: string;
  title: RestRendered;
  content: RestRendered;
  excerpt: RestRendered;
  categories?: number[];
  tags?: number[];
  featured_media: number;
  parent?: number;
}

export interface TaxonomyTerm {
  id: number;
  slug: string;
  name: string;
}
