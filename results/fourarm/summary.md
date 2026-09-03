# 4-arm 채점 요약 (k=10 평가 · Gold 7941144c · conditions 6ff1b4fc)

arm | Recall@5 | Recall@10 | Recall@20 | HIGH R@10 | LOW R@10 | LOW all_found@10 | 치명 | 경미 | 미해결 | coarse | p95(ms) | RSS(MB)
---|---|---|---|---|---|---|---|---|---|---|---|---
B | 0.493 | 0.6084 | 0.6818 | 0.588 | 0.75 | 12/19 | 0 | 0 | 0 | 103 | 21640 | 1479.9
D | 0.4895 | 0.6049 | 0.6748 | 0.588 | 0.7222 | 11/19 | 0 | 0 | 0 | 106 | 4770 | 1244.6

## 판정: PROVISIONAL_WINNER → D (PERFORMANCE_WINNER)

```json
[
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
   "B": 0,
   "D": 0
  }
 },
 {
  "step": "12 hard gate",
  "critical": {
   "B": 0,
   "D": 0
  },
  "hard_safe": [
   "B",
   "D"
  ]
 },
 {
  "step": "12 quality gate",
  "best_all": 0.6084,
  "best_high": 0.588,
  "values": {
   "B": {
    "ALL": 0.6084,
    "HIGH": 0.588
   },
   "D": {
    "ALL": 0.6049,
    "HIGH": 0.588
   }
  },
  "passed": [
   "B",
   "D"
  ]
 },
 {
  "step": "2/5 LOW all_found@10",
  "counts": {
   "B": 12,
   "D": 11
  },
  "best": 12,
  "final_tie_set": [
   "B",
   "D"
  ]
 },
 {
  "step": "5 dense-off preferred",
  "dense_off": [
   "D"
  ]
 },
 {
  "step": "winner",
  "winner": "D",
  "selection_type": "PERFORMANCE_WINNER",
  "status": "PROVISIONAL_WINNER"
 }
]
```
