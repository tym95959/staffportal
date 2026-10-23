# Staff Portal

Multi-company staff self-service portal built with plain **HTML + JavaScript**, hosted on **Vercel** (from **GitHub**), with **Firebase** for login, database and push notifications. No Firebase Storage is used — attachments go straight into the email.

## Companies, departments and who sees what

One portal serves many companies. Each company has departments; each company and department has its own staff, settings and email lists, and nobody can see another company's data (enforced by `firestore.rules`, not just hidden in the page).

| Role | Sees and manages |
|---|---|
| **Platform owner** (`super`) | Creates companies, can open any company. Uses only the Admin page. |
| **Company admin** (`admin`) | Everything in their company: all departments, staff, reports, leave, rosters, duty changes, departments, company details and email lists |
| **Department admin** (`deptadmin`) | Only their department: its staff, reports, leave, roster, leave calendar, duty changes and department email lists |
| **Staff** | Their own data, their department's roster, colleagues in their department |

**Joining:** every company has a **company code** (e.g. `KOVELI26`) and an invite link. Staff register with it, choose their department, and that company's admin (or their department admin) approves them.

**Email lists** are set at two levels for SL, FRL, annual leave and duty changes:
- **Company lists** (Admin → Settings → Company email lists) receive emails from **every** department, e.g. HR.
- **Department lists** (choose a department at the top → Settings) receive emails from **that department only**, e.g. the department head.

**SL / FRL are confidential:** the full report (reason + medical certificate attached) goes **only** to the designated SL/FRL addresses, sent as BCC so recipients don't see each other. Admins get a short notice (who, dates, number of days) with no reason and no attachment, and the push notification shows no medical details. Attachments are never stored. If a company hasn't set any SL/FRL addresses yet, the full report goes to its admins instead so the certificate isn't lost.

## What it does

| Page | Who | What |
|---|---|---|
| `index.html` | everyone | Sign in, forgot-password email |
| `register.html` | new staff | Company code → choose department → register → waits for approval (admins get a push) |
| `dashboard.html` | staff | Today's duty, next 14 days, leave balance, pending requests, my details, enable push |
| `report.html` | staff | **SL / FRL report** with attachments (medical certificate, PDF/photo). Emailed **with the files attached** to the SL or FRL email list + admins, push to admins. Files are not saved anywhere |
| `leave.html` | staff | **Annual leave** request; calendar shows the admin's daily allocation and how many slots are taken |
| `roster.html` | staff | View any month's **duty roster** (live — updates instantly) |
| `swap.html` | staff | **Duty change**: ask a colleague *in the same department at the same level*; they accept/decline. On accept the roster cells are swapped automatically, and the requester, the duty-change email list and admins get email + push |
| `password.html` | staff | Change password |
| `admin.html` | admins | Company/department picker at the top · approve staff & set department/level/role/leave entitlement · SL/FRL reports · approve/reject/revoke leave · leave calendar per department · roster per department (CSV/Excel upload) · duty changes · **Departments** (add/rename/hide) · **Settings** (invite code/link, company details, weekend days, shift codes, company + department email lists) · **Companies** (platform owner) |

Every notification is also kept in the bell (🔔) inbox inside the portal.

## How it fits together

```
Browser (HTML/JS, installable as a phone app)
   │  Firebase Auth · Firestore   (direct, protected by firestore.rules)
   │
   └─ POST /api/notify, /api/swap-respond   (Vercel serverless functions in /api)
          └─ firebase-admin → reads the record, sends push (FCM), writes inbox notifications
          └─ nodemailer (SMTP) → sends emails; SL/FRL files arrive with the request and are attached, never stored
```

---

## Setup (about 30 minutes)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> → **Add project**.
2. **Build → Authentication → Get started → Email/Password → Enable**.
3. **Build → Firestore Database → Create database** (production mode, pick a region close to you).
4. That's all — the free **Spark** plan is enough. You do **not** need to enable Storage.

### 2. Add the web config
1. **Project settings (⚙) → General → Your apps → Web (`</>`)** → register an app (no hosting needed).
2. Copy the `firebaseConfig` values into **`js/config.js`**.
3. **Project settings → Cloud Messaging → Web Push certificates → Generate key pair**. Copy the key into `self.FCM_VAPID_KEY` in `js/config.js`.
4. Optional: change `APP_NAME` (the portal's own name) in the same file. Weekend days and default annual leave are set per company in Admin → Settings.

### 3. Publish the security rules and index
Either copy-paste in the console:
- **Firestore → Rules** → paste `firestore.rules` → Publish
- **Firestore → Indexes → Composite → Add index**: collection `notifications`, fields `uid` Ascending, `createdAt` Descending

…or with the Firebase CLI: `npm i -g firebase-tools && firebase login && firebase use <project-id> && firebase deploy --only firestore`

### 4. Get a service-account key (for the server functions)
**Project settings → Service accounts → Generate new private key**. Keep the JSON file secret — never commit it to GitHub.

### 5. Choose how emails are sent (SMTP)
Any SMTP account works. With Gmail / Google Workspace:
1. Turn on 2-Step Verification for the sending account.
2. Create an **App password** (Google Account → Security → App passwords).
3. In Vercel set `EMAIL_USER=<the account>` and `EMAIL_PASS=<app password>`. The Gmail server is used automatically.

Gmail allows roughly 500 emails a day. For more, use your office mail server or a provider such as Brevo, Mailgun or SendGrid (they all give SMTP details).

### 6. Put the code on GitHub
```bash
cd staffportal
git init && git add . && git commit -m "Staff portal"
git branch -M main
git remote add origin https://github.com/<you>/staffportal.git
git push -u origin main
```

**Putting it inside an existing repo instead?** Copy the `staffportal` folder into the repo, so you get `your-repo/staffportal/index.html`, `your-repo/staffportal/api/…` and so on, then commit and push. In step 7, set Vercel's **Root Directory** to `staffportal`.

### 7. Deploy on Vercel
1. <https://vercel.com> → **Add New → Project** → import the GitHub repo. Framework preset: **Other**. No build command needed. If the files are in a `staffportal` subfolder of the repo, click **Edit** next to *Root Directory* and choose `staffportal` (for an existing project: Settings → General → Root Directory).
2. **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT1` | the **whole contents** of the service-account JSON file (paste it as one value, including the `{ }`) |
| `EMAIL_USER` | the sending email address, e.g. `office.portal@gmail.com` |
| `EMAIL_PASS` | its password — for Gmail, the 16-letter **app password** (spaces are fine) |
| `APP_URL` | optional: your site address, e.g. `https://staffportal.vercel.app` (used for links in emails; detected automatically if left out) |
| `MAIL_FROM` | optional: e.g. `Staff Portal <office.portal@gmail.com>` |
| `SMTP_HOST` / `SMTP_PORT` | optional: only if you don't use Gmail / Outlook / Yahoo / Zoho (those are detected from `EMAIL_USER`). Google Workspace addresses on your own domain use Gmail's server by default |

3. **Redeploy** after adding the variables (Deployments → ⋯ → Redeploy).
4. Every push to `main` on GitHub now deploys automatically.

### 8. Create your platform-owner account (once)
Nobody can register without a company code, so the first account is made in the Firebase console:
1. **Authentication → Users → Add user** → your email + a password. Copy the **User UID** shown in the list.
2. **Firestore Database → Start collection** (or open `users`) → collection ID `users` → **Document ID: paste the UID** → add these fields (all type *string*):

   | Field | Value |
   |---|---|
   | `name` | your name |
   | `email` | the same email |
   | `role` | `super` |
   | `status` | `active` |

3. Open the site and sign in → you land on **Admin → Companies**.

### 9. Add companies
1. **Companies → Add a company**: name, company code (suggested automatically), departments (one per line) → **Create company**.
2. The company opens. Go to **Settings** → copy the **company code** or **invite link** and send it to that company's HR person.
3. When they register, open the company → **Staff** → **Approve…** → set **Role: Company admin**. From then on they run their own company: departments, email lists, department admins, approvals.
4. Press **Send test notification** in Settings to check email and push.

Company admins can make someone a **Department admin** in Staff → Edit → Role. Staff need a **duty level** before they can request duty changes.

---

## Daily use

**Roster:** Admin → choose the department at the top → Duty roster → choose month → *Download template (CSV)* → fill it in Excel (columns `Staff ID, Name, 1, 2, 3 …`) → *Upload CSV / Excel* → check the grid → **Save & publish**. You can also type directly in the grid. Staff whose cells changed get an email + push listing the changed days; a first-time publish tells everyone on it.

**Leave calendar** (per department): Admin → choose the department → Leave calendar → tap a start and end day → set *Staff allowed on leave per day* → Apply (0 = blocked). A yearly default fills days you haven't set. Approving a request takes the slots and adds the days to the staff member's "taken" count; *Revoke* gives them back.

**Duty change:** both staff must be in the same department at the same level (set by admin). The colleague accepts from the Duty change page (or from the push/email link). The roster cells for the dates are exchanged automatically. If no roster is published for those dates, the admin email says so.

## Push notifications on phones
- **Android (Chrome):** open the site → *Enable notifications*. Optionally ⋮ → *Add to Home screen* / *Install app*.
- **iPhone (iOS 16.4+):** open in **Safari** → Share → **Add to Home Screen** → open the portal from the home-screen icon → *Enable notifications*. iPhones only allow web push from the home-screen app.
- Each device must enable notifications once. Admins can see who has push turned on in Admin → Staff (Push column).

## Notes
- **Attachments:** up to 5 files, 3 MB in total per report (a Vercel upload limit). Photos are shrunk automatically before sending, so a phone photo of a certificate normally fits easily. Files exist only in the email — the portal keeps just the file names. If the email fails, the staff member presses *Try sending again* while the files are still selected.
- Vercel's free Hobby plan is meant for personal/non-commercial use; for an organisation, check whether the Pro plan applies to you.
- Edit colours and fonts in `css/style.css`.
- **Check the security rules:** Firebase console → Firestore → Rules → **Rules Playground** lets you simulate a read as a given user (e.g. a staff member of company A trying to read `reports` of company B — it should be *denied*).
- A department admin can't approve leave for a **company admin**; the company admin's own leave is approved by another company admin or the platform owner.
- Deactivating a company (Companies → Deactivate) blocks its staff from using the portal and stops its code working; nothing is deleted.

## Files
```
index.html register.html dashboard.html report.html leave.html roster.html swap.html password.html admin.html
css/style.css            js/config.js (your settings)   js/app.js (shared)   js/admin.js
firebase-messaging-sw.js (push service worker)   manifest.json  icons/
api/_lib.js api/notify.js api/swap-respond.js   (Vercel functions)
firestore.rules firestore.indexes.json firebase.json   package.json vercel.json
```

## Data layout (Firestore)
```
orgs/{orgId}                 company details (name, code, weekendDays, defaultAL, legendText, active)
orgSettings/{orgId}          company email lists + admin email/push options        (company admins only)
departments/{deptId}         { orgId, name, active }
deptSettings/{deptId}        department email lists + extra shift codes              (company + that department's admins)
joinCodes/{CODE}             { orgId, orgName, departments[] } — read by the registration page
users/{uid}                  profile incl. orgId, deptId, role, status
directory/{uid}              name / staff ID / level / orgId / deptId (no contact details) for colleagues
reports, leaveRequests, swaps     each has orgId + deptId
rosters/{orgId}__{deptId}__{YYYY-MM}      leaveCalendar/{orgId}__{deptId}__{YYYY}
notifications/{id}           bell inbox
```
