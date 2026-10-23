// ============================================================
//  STAFF PORTAL CONFIG — fill this in (see README.md, step 2)
//  This file is loaded by every page AND by the push service
//  worker, so it uses plain `self.` globals (no import/export).
// ============================================================

// Firebase console → Project settings → General → Your apps → Web app → "SDK setup and configuration" (Config)
self.FIREBASE_CONFIG = {
  apiKey: "AIzaSyAlqXAOYrVHV1Vq1VQ2dFtj1CqQNo5-qJE",
  authDomain: "staffportal-d71d3.firebaseapp.com",
  projectId: "staffportal-d71d3",
  storageBucket: "staffportal-d71d3.firebasestorage.app",
  messagingSenderId: "268135505237",
  appId: "1:268135505237:web:facbce171f06de4a99e3dc",
  measurementId: "G-ZWQR6HFL09"
};

// Firebase console → Project settings → Cloud Messaging → Web Push certificates → "Key pair"
self.FCM_VAPID_KEY = "BJdtfacdHrm-pRRc0cH91MPiW_pjJzGPJDiKQ5as1Ivj5i6iQxEl5wPhiplboO78WZbpQ1WZ3b3YYbwYusfvL5Q";

// Shown in the top bar and page titles
self.APP_NAME = "Staff Portal";

// Weekend days shaded on the roster (0 = Sunday … 6 = Saturday). Maldives: Friday + Saturday.
self.WEEKEND_DAYS = [5, 6];

// Default annual leave entitlement (days) when the admin hasn't set one for a staff member
self.DEFAULT_AL_DAYS = 30;
