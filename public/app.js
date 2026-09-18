// ============================================================
//  app.js  —  Whatapp frontend logic
//  No frameworks, no build step. Plain ES2020 JavaScript.
// ============================================================

// ── DOM references ────────────────────────────────────────────
const feed        = document.getElementById("feed");
const feedEmpty   = document.getElementById("feed-empty");
const input       = document.getElementById("post-input");
const postBtn     = document.getElementById("post-btn");
const micBtn      = document.getElementById("mic-btn");
const toast       = document.getElementById("toast");
const fileInput   = document.getElementById("file-input");
const fileLabel   = document.getElementById("file-label");
const authOverlay = document.getElementById("auth-overlay");
const authUser    = document.getElementById("auth-username");
const authPass    = document.getElementById("auth-password");
const authBtn     = document.getElementById("auth-btn");
const authError   = document.getElementById("auth-error");
const authToggle  = document.getElementById("auth-toggle");
const authForgot  = document.getElementById("auth-forgot");
const resetPanel      = document.getElementById("reset-panel");
const resetNote       = document.getElementById("reset-note");
const resetUser       = document.getElementById("reset-username");
const resetRequestBtn = document.getElementById("reset-request-btn");
const resetError      = document.getElementById("reset-error");
const resetOr         = document.getElementById("reset-or");
const resetNewPass    = document.getElementById("reset-new-pass");
const resetConfirmPass = document.getElementById("reset-confirm-pass");
const resetConfirmBtn = document.getElementById("reset-confirm-btn");
const resetBack       = document.getElementById("reset-back");
const logoutBtn   = document.getElementById("logout-btn");
const headerUser  = document.getElementById("header-user");
const attachPrev  = document.getElementById("attach-preview");
const dropOverlay = document.getElementById("drop-overlay");
const recStatus   = document.getElementById("rec-status");
const recTime     = document.getElementById("rec-time");

let toastTimer  = null;
let currentUser = null;
let isLogin     = true;
let sse         = null;
let attachments = [];
let recorder    = null;
let recChunks   = [];
let recMime     = "";
let recTimer    = null;
let recSeconds  = 0;
const localIds  = new Set();


// ============================================================
//  showToast(message)
//  Briefly displays a small notification at the bottom of the
//  screen for errors or confirmations.
// ============================================================
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}


// ============================================================
//  formatTime(timestamp)
//  Converts a Unix ms timestamp to a human-readable string
//  like "Today at 3:42 PM" or "Jun 10 at 11:05 AM".
// ============================================================
function formatTime(ts) {
  if (!ts) return "";
  const d   = new Date(ts);
  const now = new Date();
  const isToday =
    d.getDate()     === now.getDate()  &&
    d.getMonth()    === now.getMonth() &&
    d.getFullYear() === now.getFullYear();

  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today at ${time}`;
  const month = d.toLocaleString("default", { month: "short" });
  return `${month} ${d.getDate()} at ${time}`;
}


// ============================================================
//  syncEmptyState()
//  Shows or hides the "board is clean" placeholder depending
//  on whether any .post elements currently exist in the feed.
// ============================================================
function syncEmptyState() {
  const hasPosts = feed.querySelector(".post") !== null;
  feedEmpty.style.display = hasPosts ? "none" : "block";
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch (_) {
    const text = await response.text();
    return { error: text || `Server error ${response.status}` };
  }
}


// ============================================================
//  createPostElement(post)
//  Builds and returns a complete <section class="post"> DOM
//  node from a post object { id, text, timestamp, file }.
//
//  HOW DYNAMIC SECTION CREATION WORKS:
//    This function is called in two places:
//      1. Inside loadPosts() for every post returned by the server.
//      2. After a successful POST /api/posts to show the new post
//         immediately without a full page reload.
//
//    Each call creates the elements from scratch with
//    document.createElement(), fills them with data, wires up
//    the Delete button, assembles them, and returns the root
//    <section>. The caller decides where in the DOM to put it.
// ============================================================
function createPostElement(post) {
  const section = document.createElement("section");
  section.classList.add("post");
  section.dataset.id = post.id;
  section.dataset.author = post.author;
  section.dataset.ts = post.timestamp;
  if (currentUser && post.author === currentUser) section.classList.add("own");

  const authorEl = document.createElement("span");
  authorEl.classList.add("post-author");
  authorEl.textContent = post.author;
  section.appendChild(authorEl);

  const bubble = document.createElement("div");
  bubble.classList.add("bubble");

  if (post.text) {
    const textEl = document.createElement("p");
    textEl.classList.add("post-text");
    textEl.textContent = post.text;
    bubble.appendChild(textEl);
  }

  if (post.files && post.files.length) {
    post.files.forEach(file => {
      const url  = "/uploads/" + file.filename;
      const mime = file.mimetype || "";
      if (mime.startsWith("image/")) {
        const a = document.createElement("a");
        a.href = url; a.target = "_blank"; a.rel = "noopener";
        const img = document.createElement("img");
        img.classList.add("post-image");
        img.src = url;
        img.alt = file.original;
        a.appendChild(img);
        bubble.appendChild(a);
      } else if (mime.startsWith("audio/")) {
        const audio = document.createElement("audio");
        audio.classList.add("post-audio");
        audio.controls = true;
        audio.src = url;
        bubble.appendChild(audio);
      } else if (mime.startsWith("video/")) {
        const video = document.createElement("video");
        video.classList.add("post-video");
        video.controls = true;
        video.src = url;
        bubble.appendChild(video);
      } else {
        const a = document.createElement("a");
        a.classList.add("post-file");
        a.href = url; a.target = "_blank"; a.rel = "noopener";
        const icon = document.createElement("span");
        icon.classList.add("post-file-icon");
        icon.textContent = "📎";
        const nameEl = document.createElement("span");
        nameEl.textContent = file.original;
        a.appendChild(icon);
        a.appendChild(nameEl);
        bubble.appendChild(a);
      }
    });
  }

  const meta = document.createElement("div");
  meta.classList.add("post-meta");

  const timeEl = document.createElement("span");
  timeEl.textContent = formatTime(post.timestamp);
  meta.appendChild(timeEl);

  const ticks = document.createElement("span");
  ticks.classList.add("post-ticks");
  ticks.textContent = "✓✓";
  meta.appendChild(ticks);

  if (currentUser && post.author === currentUser) {
    const deleteBtn = document.createElement("button");
    deleteBtn.classList.add("post-delete");
    deleteBtn.title = "Erase this post";
    deleteBtn.textContent = "✕";
    deleteBtn.setAttribute("aria-label", "Delete post");
    deleteBtn.addEventListener("click", () => {
      localIds.add(post.id);
      deletePost(post.id, section);
    });
    meta.appendChild(deleteBtn);
  }

  bubble.appendChild(meta);
  section.appendChild(bubble);
  return section;
}


// ============================================================
//  dateKey(ts) / dateLabel(ts) / maybeAddDateChip(ts)
//  Renders WhatsApp-style date separators ("Today", "Yesterday",
//  or a full date) between messages from different days.
// ============================================================
function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dateLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest  = new Date();
  yest.setDate(today.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth()    &&
    a.getDate()     === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yest))  return "Yesterday";
  return d.toLocaleDateString("default", { weekday: "long", month: "long", day: "numeric" });
}

function maybeAddDateChip(ts) {
  const posts = feed.querySelectorAll(".post");
  const prev  = posts[posts.length - 1];
  if (!prev) return;
  if (dateKey(Number(prev.dataset.ts)) === dateKey(ts)) return;
  const chip = document.createElement("div");
  chip.classList.add("date-chip");
  chip.textContent = dateLabel(ts);
  feed.appendChild(chip);
}

// ============================================================
//  maybeGroup(section)
//  When a post continues a run by the same author, flag it as
//  "grouped" so CSS tightens the spacing and hides the name.
// ============================================================
function maybeGroup(section) {
  const posts = feed.querySelectorAll(".post");
  const prev  = posts[posts.length - 1];
  if (prev && prev.dataset.author === section.dataset.author) {
    section.classList.add("grouped");
  }
}

// ============================================================
//  scrollToBottom(smooth)
//  Keeps the newest message visible at the bottom of the feed.
// ============================================================
function scrollToBottom(smooth) {
  feed.scrollIntoView({ block: "end", behavior: smooth ? "smooth" : "auto" });
}

// ============================================================
//  appendPost(section, scroll)
//  Adds a post to the bottom of the feed in chat-log order,
//  handling date separators, grouping, empty-state, and scroll.
// ============================================================
function appendPost(section, scroll = true) {
  maybeAddDateChip(Number(section.dataset.ts));
  maybeGroup(section);
  feed.appendChild(section);
  syncEmptyState();
  if (scroll) scrollToBottom(true);
}

// ============================================================
//  loadPosts()
//  Called once on page load.
//  Fetches GET /api/posts, then renders each post by calling
//  createPostElement() and appending it to #feed (oldest first).
// ============================================================
async function loadPosts() {
  try {
    const res   = await fetch("/api/posts", { credentials: "same-origin" });
    if (!res.ok) {
      const { error } = await parseJsonSafe(res);
      throw new Error(error || `Server error ${res.status}`);
    }
    const posts = await parseJsonSafe(res);   // array of {id, text, timestamp}

    // Render each post (skip any that SSE already inserted during fetch).
    posts.forEach(post => {
      if (feed.querySelector(`[data-id="${post.id}"]`)) return;
      const section = createPostElement(post);
      appendPost(section, false);
    });

    scrollToBottom(false);

  } catch (err) {
    console.error("loadPosts failed:", err);
    showToast("Could not load posts — is the server running?");
  }
}


// ============================================================
//  submitPost()
//  Reads the textarea, POSTs the text to /api/posts, and
//  prepends the returned post to the top of the feed.
// ============================================================
async function submitPost() {
  if (postBtn.disabled) return;
  if (recorder) return;

  const text = input.value.trim();
  if (!text && attachments.length === 0) return;

  postBtn.disabled   = true;
  postBtn.classList.add("sending");

  try {
    const formData = new FormData();
    if (text) formData.append("text", text);
    attachments.forEach(file => formData.append("files", file));

    const res = await fetch("/api/posts", {
      method: "POST",
      credentials: "same-origin",
      body:   formData
    });

    if (!res.ok) {
      const { error } = await parseJsonSafe(res);
      throw new Error(error || `Server error ${res.status}`);
    }

    const newPost = await parseJsonSafe(res);
    localIds.add(newPost.id);

    // Insert locally, but only if SSE didn't already insert it
    if (!feed.querySelector(`[data-id="${newPost.id}"]`)) {
      const section = createPostElement(newPost);
      appendPost(section);
    }

    // Clear inputs
    input.value       = "";
    input.style.height = "auto";
    fileLabel.classList.remove("has-file");
    clearAttachments();

  } catch (err) {
    console.error("submitPost failed:", err);
    showToast(`Could not post: ${err.message}`);
  } finally {
    postBtn.disabled         = false;
    postBtn.classList.remove("sending");
    updateSendBtn();
    input.focus();
  }
}


// ============================================================
//  deletePost(id, sectionEl)
//  Sends DELETE /api/posts/:id to the server.
//  On success, animates the <section> out and removes it from
//  the DOM. The record is also gone from posts.json on the server.
//
//  HOW FILE DELETION WORKS ON THE BACKEND (server.js summary):
//    1. Express receives DELETE /api/posts/:id
//    2. readDB() loads the full array from posts.json
//    3. Array.filter() creates a new array without the target post
//    4. writeDB() overwrites posts.json with the filtered array
//    5. Server responds 204 — the post no longer exists anywhere
// ============================================================
async function deletePost(id, sectionEl) {
  try {
    const res = await fetch(`/api/posts/${id}`, { method: "DELETE", credentials: "same-origin" });
    if (res.status === 404) {
      sectionEl.remove();
      syncEmptyState();
      return;
    }
    if (!res.ok) {
      const { error } = await parseJsonSafe(res);
      throw new Error(error || `Server error ${res.status}`);
    }

    sectionEl.classList.add("erasing");
    setTimeout(() => {
      sectionEl.remove();
      syncEmptyState();
    }, 230);

  } catch (err) {
    console.error("deletePost failed:", err);
    showToast(`Could not erase that post: ${err.message}`);
  }
}


// ============================================================
//  Attachment helpers
//  Single source of truth for files attached to the next post.
//  Files arrive via browse, clipboard paste, or drag & drop.
// ============================================================
const MAX_FILES = 10;

function formatBytes(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function addAttachment(file) {
  if (attachments.length >= MAX_FILES) {
    showToast(`Maximum ${MAX_FILES} files per post.`);
    return;
  }
  attachments.push(file);
  renderAttachments();
  updateSendBtn();
}

function removeAttachment(index) {
  const file = attachments[index];
  attachments.splice(index, 1);
  if (file && file._thumbUrl) URL.revokeObjectURL(file._thumbUrl);
  renderAttachments();
  updateSendBtn();
}

function clearAttachments() {
  attachments.forEach(file => {
    if (file._thumbUrl) URL.revokeObjectURL(file._thumbUrl);
  });
  attachments = [];
  renderAttachments();
  updateSendBtn();
}

function renderAttachments() {
  attachPrev.innerHTML = "";
  attachPrev.classList.toggle("has-files", attachments.length > 0);
  fileLabel.classList.toggle("has-file", attachments.length > 0);
  attachments.forEach((file, i) => {
    const chip = document.createElement("div");
    chip.classList.add("attach-chip");

    const thumb = document.createElement("div");
    thumb.classList.add("attach-thumb");
    if (file.type && file.type.startsWith("image/")) {
      if (!file._thumbUrl) file._thumbUrl = URL.createObjectURL(file);
      const img = document.createElement("img");
      img.src = file._thumbUrl;
      img.alt = "";
      thumb.appendChild(img);
    } else {
      thumb.textContent = "📄";
    }
    chip.appendChild(thumb);

    const info = document.createElement("div");
    info.classList.add("attach-info");
    const name = document.createElement("div");
    name.classList.add("attach-name");
    name.textContent = file.name;
    const size = document.createElement("div");
    size.classList.add("attach-size");
    size.textContent = formatBytes(file.size);
    info.appendChild(name);
    info.appendChild(size);
    chip.appendChild(info);

    const rm = document.createElement("button");
    rm.classList.add("attach-remove");
    rm.textContent = "✕";
    rm.setAttribute("aria-label", "Remove attachment");
    rm.addEventListener("click", () => removeAttachment(i));
    chip.appendChild(rm);

    attachPrev.appendChild(chip);
  });
}

// ============================================================
//  updateSendBtn()
//  Send stays visible; it just turns disabled until there is
//  text or an attachment. Mic is a separate, always-visible
//  button next to it.
// ============================================================
function updateSendBtn() {
  if (recorder) { postBtn.disabled = true; return; }
  postBtn.disabled = input.value.trim().length === 0 && attachments.length === 0;
}


// ============================================================
//  Voice notes — capture from the mic and attach the audio
//  (browsers require a secure context, so this works on
//  localhost or HTTPS, not plain LAN HTTP).
// ============================================================
const REC_MAX_SECONDS = 120;

function updateRecTimer() {
  const m = Math.floor(recSeconds / 60);
  const s = recSeconds % 60;
  recTime.textContent = `${m}:${s.toString().padStart(2, "0")}`;
  if (recSeconds >= REC_MAX_SECONDS) stopRecording();
}

async function toggleMic() {
  if (recorder) { stopRecording(); return; }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
      typeof MediaRecorder === "undefined") {
    showToast("Voice recording isn't supported in this browser.");
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error("mic denied:", err);
    showToast("Microphone permission was denied.");
    return;
  }

  try {
    const mimeType = MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
    recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    recMime   = recorder.mimeType || mimeType || "audio/webm";
    recChunks = [];

    recorder.addEventListener("dataavailable", e => {
      if (e.data && e.data.size) recChunks.push(e.data);
    });

    recorder.addEventListener("stop", () => {
      const blob = new Blob(recChunks, { type: recMime });
      stream.getTracks().forEach(t => t.stop());
      const ext = recMime.includes("mp4") ? "mp4" : "webm";
      const file = new File([blob], `voice-note.${ext}`, {
        type: recMime,
        lastModified: Date.now()
      });
      if (file.size > 0) addAttachment(file);
      else showToast("Recording was empty.");
    });

    recorder.addEventListener("error", () => {
      stopRecording();
      showToast("Recording failed.");
    });

    recorder.start();
    startRecUi();
  } catch (err) {
    console.error("mic start failed:", err);
    stream.getTracks().forEach(t => t.stop());
    showToast("Could not start recording.");
  }
}

function stopRecording() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  clearRecUi();
  if (r.state !== "inactive") r.stop();
}

function startRecUi() {
  micBtn.classList.add("recording");
  recSeconds = 0;
  updateRecTimer();
  recStatus.classList.add("show");
  recTimer = setInterval(() => {
    recSeconds++;
    updateRecTimer();
  }, 1000);
}

function clearRecUi() {
  micBtn.classList.remove("recording");
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  recStatus.classList.remove("show");
  updateSendBtn();
}


// ── Event listeners ───────────────────────────────────────────
postBtn.addEventListener("click", submitPost);
micBtn.addEventListener("click", toggleMic);

// Enter = post, Shift+Enter = newline
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitPost();
  }
});

// File input — append selected files as attachments
fileInput.addEventListener("change", () => {
  [...fileInput.files].forEach(f => addAttachment(f));
  fileInput.value = "";
  fileLabel.classList.toggle("has-file", attachments.length > 0);
});

// Clipboard paste — attach any pasted files (images, docs, ...)
document.addEventListener("paste", e => {
  if (authOverlay.classList.contains("hidden") === false) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  let added = 0;
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) { addAttachment(file); added++; }
  }
  if (added > 0) e.preventDefault();
});

// Drag & drop — attach dropped files anywhere on the board
let dragDepth = 0;
function hasFiles(types) {
  return types && Array.prototype.indexOf.call(types, "Files") !== -1;
}
document.addEventListener("dragenter", e => {
  if (!hasFiles(e.dataTransfer && e.dataTransfer.types)) return;
  if (authOverlay.classList.contains("hidden") === false) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add("show");
});
document.addEventListener("dragover", e => {
  if (!hasFiles(e.dataTransfer && e.dataTransfer.types)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.remove("show");
});
document.addEventListener("drop", e => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove("show");
  if (authOverlay.classList.contains("hidden") === false) return;
  if (e.dataTransfer && e.dataTransfer.files) {
    [...e.dataTransfer.files].forEach(f => addAttachment(f));
  }
});

// Auto-grow the textarea as the user types
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 130) + "px";
  updateSendBtn();
});


// ── Auth helpers ──────────────────────────────────────────────

async function checkAuth() {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    const { user, error } = await parseJsonSafe(res);
    if (res.ok && user) {
      currentUser = user.username;
      authOverlay.classList.add("hidden");
      headerUser.textContent = currentUser;
      loadPosts();
      connectSSE();
    } else {
      authOverlay.classList.remove("hidden");
      if (error) console.warn("Auth check failed:", error);
    }
  } catch (err) {
    console.error("checkAuth failed:", err);
    authOverlay.classList.remove("hidden");
  }
}

async function handleAuth() {
  const username = authUser.value.trim();
  const password = authPass.value;
  if (!username || !password) return;
  authBtn.disabled    = true;
  authBtn.textContent = isLogin ? "Signing in…" : "Creating account…";
  authError.textContent = "";

  try {
    const res = await fetch(`/api/${isLogin ? "login" : "register"}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ username, password })
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    currentUser = data.username;
    authOverlay.classList.add("hidden");
    headerUser.textContent = currentUser;
    loadPosts();
    connectSSE();
  } catch (err) {
    authError.textContent = err.message;
  } finally {
    authBtn.disabled    = false;
    authBtn.textContent = isLogin ? "Sign in" : "Create account";
  }
}

async function handleLogout() {
  try { await fetch("/api/logout", { method: "POST", credentials: "same-origin" }); } catch (_) {}
  if (sse) sse.close();
  location.reload();
}

// ── Password reset ────────────────────────────────────────────
function showSignInForm() {
  resetPanel.classList.add("hidden");
  authUser.classList.remove("hidden");
  authPass.classList.remove("hidden");
  authBtn.classList.remove("hidden");
  authError.classList.remove("hidden");
  authToggle.classList.remove("hidden");
  authForgot.classList.remove("hidden");
  resetError.textContent = "";
}

function showResetRequest() {
  resetPanel.classList.remove("hidden");
  authUser.classList.add("hidden");
  authPass.classList.add("hidden");
  authBtn.classList.add("hidden");
  authError.classList.add("hidden");
  authToggle.classList.add("hidden");
  authForgot.classList.add("hidden");
  resetNote.textContent = "Enter your username and we'll send a reset link to the email on the account.";
  resetOr.classList.remove("hidden");
  resetRequestBtn.classList.remove("hidden");
  resetUser.classList.remove("hidden");
  resetNewPass.classList.add("hidden");
  resetConfirmPass.classList.add("hidden");
  resetConfirmBtn.classList.add("hidden");
  resetError.textContent = "";
}

async function handleResetRequest() {
  const username = resetUser.value.trim();
  if (!username) return;
  resetRequestBtn.disabled    = true;
  resetRequestBtn.textContent = "Sending…";
  try {
    const res = await fetch("/api/reset/request", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ username })
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    resetNote.textContent = "If an account exists for that username, a reset link has been sent to its email address.";
    resetError.textContent = "";
  } catch (err) {
    resetError.textContent = err.message;
  } finally {
    resetRequestBtn.disabled    = false;
    resetRequestBtn.textContent = "Send reset link";
  }
}

async function handleResetConfirm() {
  const pass  = resetNewPass.value;
  const pass2 = resetConfirmPass.value;
  if (pass.length < 4) { resetError.textContent = "Password must be at least 4 characters."; return; }
  if (pass !== pass2)  { resetError.textContent = "Passwords don't match."; return; }

  const token = new URLSearchParams(location.search).get("reset");
  if (!token) { resetError.textContent = "Missing reset token."; return; }

  resetConfirmBtn.disabled    = true;
  resetConfirmBtn.textContent = "Saving…";
  try {
    const res = await fetch("/api/reset/confirm", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ token, newPassword: pass })
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    history.replaceState(null, "", location.pathname);
    showToast("Password updated. Sign in with your new password.");
    showSignInForm();
    authPass.focus();
  } catch (err) {
    resetError.textContent = err.message;
  } finally {
    resetConfirmBtn.disabled    = false;
    resetConfirmBtn.textContent = "Set new password";
  }
}

function initResetMode() {
  const token = new URLSearchParams(location.search).get("reset");
  if (!token) return;
  resetPanel.classList.remove("hidden");
  authUser.classList.add("hidden");
  authPass.classList.add("hidden");
  authBtn.classList.add("hidden");
  authError.classList.add("hidden");
  authToggle.classList.add("hidden");
  authForgot.classList.add("hidden");
  resetNote.textContent = "Choose a new password.";
  resetOr.classList.add("hidden");
  resetRequestBtn.classList.add("hidden");
  resetUser.classList.add("hidden");
  resetNewPass.classList.remove("hidden");
  resetConfirmPass.classList.remove("hidden");
  resetConfirmBtn.classList.remove("hidden");
}

// ── SSE — real‑time updates ──────────────────────────────────
function connectSSE() {
  sse = new EventSource("/api/events", { withCredentials: true });

  sse.addEventListener("post-created", e => {
    const post = JSON.parse(e.data);
    if (localIds.has(post.id)) { localIds.delete(post.id); return; }
    if (feed.querySelector(`[data-id="${post.id}"]`)) return;
    const section = createPostElement(post);
    appendPost(section);
  });

  sse.addEventListener("post-deleted", e => {
    const { id } = JSON.parse(e.data);
    if (localIds.has(id)) { localIds.delete(id); return; }
    const section = feed.querySelector(`[data-id="${id}"]`);
    if (!section) return;
    section.classList.add("erasing");
    setTimeout(() => { section.remove(); syncEmptyState(); }, 230);
  });

  sse.addEventListener("error", () => {});
}

// ── Auth event listeners ─────────────────────────────────────
authBtn.addEventListener("click", handleAuth);

authUser.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); authPass.focus(); }
});
authPass.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); handleAuth(); }
});

authToggle.addEventListener("click", () => {
  isLogin = !isLogin;
  authBtn.textContent = isLogin ? "Sign in" : "Create account";
  authToggle.textContent = isLogin ? "No account? Create one" : "Already have an account? Sign in";
  authError.textContent = "";
});

authForgot.addEventListener("click", showResetRequest);
resetBack.addEventListener("click", showSignInForm);
resetRequestBtn.addEventListener("click", handleResetRequest);
resetConfirmBtn.addEventListener("click", handleResetConfirm);
resetUser.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); handleResetRequest(); }
});
resetNewPass.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); handleResetConfirm(); }
});

logoutBtn.addEventListener("click", handleLogout);

// ── Init ─────────────────────────────────────────────────────
updateSendBtn();
initResetMode();
checkAuth();
