import { scorePair, type Fingerprint } from "./componentMatch";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function fp(partial: Partial<Fingerprint> & Pick<Fingerprint, "typeCounts" | "typePath">): Fingerprint {
  return {
    childCount: 2,
    width: 96,
    height: 36,
    layoutMode: "HORIZONTAL",
    paddingKey: "8,16,8,16",
    itemSpacing: 8,
    hasText: true,
    textLenBucket: 8,
    hasRadius: true,
    hasFill: true,
    ...partial,
  };
}

// Invite-style button: VECTOR icon+TEXT vs INSTANCE icon+TEXT after SHAPE normalize
const vectorStyle = fp({
  typeCounts: "BOX:1|SHAPE:1|TEXT:1",
  typePath: "BOX>SHAPE>TEXT",
});
const instanceStyle = fp({
  typeCounts: "BOX:1|SHAPE:1|TEXT:1",
  typePath: "BOX>SHAPE>TEXT",
});
assert(scorePair(vectorStyle, instanceStyle) >= 0.7, "vector vs icon-instance twins score >= 0.7");

// Pre-normalize mismatch would have been VECTOR vs INSTANCE — still below threshold if raw types leak
const rawMismatch = scorePair(
  fp({ typeCounts: "BOX:1|TEXT:1|VECTOR:1", typePath: "BOX>VECTOR>TEXT" }),
  fp({ typeCounts: "BOX:2|TEXT:1", typePath: "BOX>BOX>TEXT" })
);
assert(rawMismatch < 0.7, "raw VECTOR vs INSTANCE BOX still fails (normalize must run in walk)");

// exact size earns 0.12; nearSize's 0.08 stays unearned → max 0.92
assert(scorePair(vectorStyle, vectorStyle) >= 0.9, "identical fingerprints near-max");

console.log("ok");
