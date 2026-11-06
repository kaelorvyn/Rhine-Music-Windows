export interface Word { text: string; start: number; end: number }
export interface WordLine { time: number; text: string; words?: Word[] }
export function validWords(text: string, words: unknown, time: number): words is Word[];
export function parseWordLyrics(source: string): WordLine[];
export function withWordLyrics<T>(lyrics: T): T & { wordLines?: WordLine[] };
