Read `.agentloop/metrics.jsonl` and summarize it conversationally.
If multiple rows exist for the same `task_id`, use only the latest timestamp.
Cover:
- Average rounds per task in the last 7 days
- Average time per task
- First-pass clean rate (`rounds = 1`)
- Stuck rate (`outcome = stuck`)
- Most common error type
- Trend vs the previous 7 days (`improving`, `flat`, or `degrading`)
If the file is missing or empty, say no metrics have been recorded yet.
