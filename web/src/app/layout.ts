/**
 * The reading column of the transcript and composer; `dock` fits them into a narrow side region. Its width is the
 * `--reading-width` variable on the root element (a user extension may set it), 46rem when unset.
 */
export const column = (dock?: boolean) =>
  dock ? 'w-full px-4' : 'mx-auto w-full max-w-(--reading-width,46rem) px-3 sm:px-6'
