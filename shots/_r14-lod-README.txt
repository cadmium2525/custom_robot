ROUND 14 — DOES THE SILHOUETTE LOD FIRE?
========================================
Probe: shots/_lodprobe.mjs, build fbc1484, served from shots/_root_r14 on :4311
(a PRIVATE serving root — another agent was running _salience.mjs and `vite build`
on this box at the same time, and shots/_root is whatever their last _snap.sh put
there. Byte-verified: served index-BZQ6jQGy.js md5 90061ffc... == my dist/.)

SHIPPED DEFAULT is robot.js:2009  LOD_MIN_PX2 = 2.0

At that value, foundry, tier 3, 1600x900:

  ROBOT 1 (player)    on-screen 331.7px   budget 10401   236/236 prims   DROPPED 0
  ROBOT 2 (opponent)  on-screen 102.5px   budget   994   219/224 prims   DROPPED 5 (2.2%)

ANSWER: the LOD fires — the cut runs, the budget is finite, the draw ranges move —
but at shipped scale it removes NOTHING from the player and 2.2% from the opponent.
It cannot be the lever on foundry's failing player cell, which is the worst cell in
the table at 7.3-7.5 masses. A machine 331px tall has budget to spare, and that is
the correct behaviour; it just means item 2 is not where the remaining defect is.

Threshold sweep (one launch, --sweep 0,2,6,16,32), prims kept / dropped:

  minPx2    ROBOT 1 (331.7px)        ROBOT 2 (102.5px)
       0    236/236   dropped  0     224/224   dropped  0    (gate off, px=Infinity)
       2    236/236   dropped  0     219/224   dropped  5    <- SHIPPED
       6    236/236   dropped  0     193/224   dropped 31
      16    231/236   dropped  5     158/224   dropped 66
      32    218/236   dropped 18     125/224   dropped 99

The player does not begin to lose anything until minPx2 16, and the review already
recorded that the mass count across minPx2 0/2/16 moves by less than the noise
floor. Both halves agree: the geometry LOD is not the remaining defect.
