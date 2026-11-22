/**
 * Where the Suwayomi adapter says what it saw, for the chapter catalogue
 * (`catalogue.ts`) to keep.
 *
 * Every listing a source answers (a search, a page of its popular or latest
 * list) and every chapter list fetched from a site passes through the adapter,
 * so noting them there fills the catalogue at no cost: nothing is asked for its
 * sake. A file of its own so the adapter does not import the catalogue, which
 * imports the adapter.
 *
 * A listener that throws is ignored: keeping a note must never break a search.
 */
import type { SourceChapter, SourceMatch } from './sources.js';

export interface ListedSource {
  id: string;
  displayName: string;
  lang: string;
}

type ListingListener = (source: ListedSource, kind: 'POPULAR' | 'LATEST' | 'SEARCH', matches: readonly SourceMatch[]) => void;
type ChaptersListener = (mangaId: string, chapters: readonly SourceChapter[]) => void;

let onListing: ListingListener | null = null;
let onChapters: ChaptersListener | null = null;

/** Called once by the catalogue as it loads. */
export function hearNotes(listing: ListingListener, chapters: ChaptersListener): void {
  onListing = listing;
  onChapters = chapters;
}

export function noteListing(source: ListedSource, kind: 'POPULAR' | 'LATEST' | 'SEARCH', matches: readonly SourceMatch[]): void {
  try {
    onListing?.(source, kind, matches);
  } catch {
    // A note, not the work.
  }
}

/** A chapter list fresh from the site; Suwayomi's stored copy is not noted, since its age is unknown here. */
export function noteChapters(mangaId: string, chapters: readonly SourceChapter[]): void {
  try {
    onChapters?.(mangaId, chapters);
  } catch {
    // A note, not the work.
  }
}
