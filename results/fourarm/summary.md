# 4-arm 채점 요약 (k=10 평가 · Gold 7941144c · conditions 83d5b8a0)

arm | Recall@5 | Recall@10 | Recall@20 | HIGH R@10 | LOW R@10 | LOW all_found@10 | 치명 | 경미 | 미해결 | coarse | p95(ms) | RSS(MB)
---|---|---|---|---|---|---|---|---|---|---|---|---
B | 0.479 | 0.5874 | 0.6713 | 0.576 | 0.6667 | 11/19 | 2 | 0 | 15 | 99 | 22739 | 1423.0
D | 0.486 | 0.5839 | 0.6678 | 0.576 | 0.6389 | 9/19 | 2 | 0 | 11 | 103 | 4077 | 1260.2

## 판정: BLOCKED — no hard-safe arm

```json
[
 {
  "step": "16 adjudication",
  "common_excluded": [],
  "limit": 5,
  "arm_specific": {
   "B": 2,
   "D": 2
  },
  "arm_specific_critical": {
   "B": [
    "u-1b6cd184a87f",
    "u-8564414f6080"
   ],
   "D": [
    "u-1b6cd184a87f",
    "u-8564414f6080"
   ]
  },
  "unknown_remaining": {
   "B": 15,
   "D": 11
  }
 },
 {
  "step": "14 locator checked",
  "unchecked": []
 },
 {
  "step": "20 pins",
  "bad": []
 },
 {
  "step": "16 unresolved",
  "counts": {
   "B": 15,
   "D": 11
  }
 },
 {
  "step": "12 hard gate",
  "critical": {
   "B": 2,
   "D": 2
  },
  "hard_safe": []
 }
]
```
