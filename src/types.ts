// src/types.ts

export type MetadataState = 'Unset' | 'Sync TMDB' | 'Manual Set' | 'Extract Subs' | 'Set Subs';

export interface Subtitle {
    label: string;
    language: string;
    path: string;
    isEmbedded?: boolean;
}

export interface MediaInfo {
    duration: number;
    codec: string;
    width: number;
    height: number;
}

export interface MetaData {
    type: "movie" | "tv" | "season" | "episode";
    tmdbId: string | number;
    title: string;
    rating: number;
    year: string;
    genres: string[];
    countries: string[];
    poster: string | null;
    runtime?: number;
    state?: MetadataState;
    season_number?: number | null
    episode_number?: number | null
}

export interface FileNode {
    uuid: string;
    name: string;
    type: "directory" | "file";
    path: string;
    size: number;
    mtime: string;
    children?: FileNode[];
    meta?: MetaData;
    subtitles?: Subtitle[];
    mediaInfo?: MediaInfo;
}

export interface ConfigData {
    rootDrive: string;
}