// The empty state, written once and shown in two places: the watchlist when it
// holds nothing, and the feed when this person follows nothing.
//
// It is a component rather than a pair of strings because the second sentence
// carries a link in the middle of it, and a sentence assembled from fragments
// at each call site is a sentence that drifts. M1 asks for "empty states that
// explain what happens next", so this says what to do rather than only that
// there is nothing here.
//
// The control it names, Watch on recompeteradar.ca, exists only after that
// site is rebuilt with the Watch links. The app ships first on purpose, so the
// address those links point at exists before anything points at it; until the
// site rebuild the instruction is true of the plan and not yet of the page.

export function NothingWatched() {
  return (
    <>
      <p>You are not watching anything yet.</p>
      <p>
        Find a contract or a supplier on{' '}
        <a href="https://recompeteradar.ca">recompeteradar.ca</a> and press Watch.
      </p>
    </>
  )
}
