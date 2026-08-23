import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";

const raw = readFileSync(".env.local", "utf-8");
const env = Object.fromEntries(
  raw.split(/\r?\n/)
    .filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => {
      const idx = l.indexOf("=");
      const key = l.slice(0, idx).trim();
      const val = l.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
      return [key, val];
    })
);

initializeApp({
  credential: cert({
    projectId: env.FIREBASE_ADMIN_PROJECT_ID,
    clientEmail: env.FIREBASE_ADMIN_CLIENT_EMAIL,
    privateKey: env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = getFirestore();

const configSnap = await db.doc("appConfig/main").get();
const { firstAgencyId } = configSnap.data();
console.log("Agency ID:", firstAgencyId);

await db.doc(`agencies/${firstAgencyId}`).update({
  name: "Answer Any Call",
});

console.log('Done — agency name updated to "Answer Any Call"');
process.exit(0);
