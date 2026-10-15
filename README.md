# ComikFlix

## Assumptions

- **Every series is weekly.** A series stores a release *day* (`series.release_day`, 0=Mon … 6=Sun,
  set by hand), never a release date: a date only fits one chapter and goes stale once it comes out.
  The next chapter is due on the first release day after the latest chapter; with no release day set,
  the latest chapter's weekday counts. There is no other cadence and no interval estimate
  (`server.next_release`). If a series turns out not to be weekly, adapt the model then.
- Chapters keep their exact publish time from the source (`chapters.published_at`).
