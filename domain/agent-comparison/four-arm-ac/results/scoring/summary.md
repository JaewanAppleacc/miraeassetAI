# 4-arm 채점 요약 (k=10 평가 · Gold 7941144c · conditions 83d5b8a0)

arm | Recall@5 | Recall@10 | Recall@20 | HIGH R@10 | LOW R@10 | LOW all_found@10 | 치명 | 경미 | 미해결 | coarse | p95(ms) | RSS(MB)
---|---|---|---|---|---|---|---|---|---|---|---|---
A | 0.7692 | 0.8007 | 0.8217 | 0.784 | 0.9167 | 16/19 | 0 | 0 | 229 | 0 | 1593 | None
B | 0.479 | 0.5874 | 0.6713 | 0.576 | 0.6667 | 11/19 | 2 | 0 | 15 | 99 | 22739 | 1423.0
C | 0.7273 | 0.7552 | 0.8462 | 0.74 | 0.8611 | 15/19 | 0 | 0 | 216 | 0 | 584 | None
D | 0.486 | 0.5839 | 0.6678 | 0.576 | 0.6389 | 9/19 | 2 | 0 | 11 | 103 | 4077 | 1260.2

## 판정: PENDING_UNRESOLVED — 후보 A (Owner UNRESOLVED 판정 후 재실행)

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
   "A": 229,
   "B": 15,
   "C": 216,
   "D": 11
  }
 },
 {
  "step": "0 arm completeness",
  "required": [
   "A",
   "B",
   "C",
   "D"
  ],
  "missing": [],
  "extra": []
 },
 {
  "step": "0 per-arm completeness",
  "missing_or_error": {}
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
   "A": 229,
   "B": 15,
   "C": 216,
   "D": 11
  }
 },
 {
  "step": "12 hard gate",
  "critical": {
   "A": 0,
   "B": 2,
   "C": 0,
   "D": 2
  },
  "hard_safe": [
   "A",
   "C"
  ]
 },
 {
  "step": "12 quality gate",
  "best_all": 0.8007,
  "best_high": 0.784,
  "values": {
   "A": {
    "ALL": 0.8007,
    "HIGH": 0.784
   },
   "C": {
    "ALL": 0.7552,
    "HIGH": 0.74
   }
  },
  "passed": [
   "A"
  ]
 },
 {
  "step": "2/5 LOW all_found@10",
  "counts": {
   "A": 16
  },
  "best": 16,
  "final_tie_set": [
   "A"
  ]
 },
 {
  "step": "16C selection held",
  "candidate": "A",
  "selection_type": "PERFORMANCE_WINNER"
 }
]
```
