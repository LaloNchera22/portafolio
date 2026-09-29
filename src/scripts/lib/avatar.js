/* ============================================================================
 * Runinback — profile photos. One object per player at avatars/<uid>/avatar.webp
 * (public bucket, migration 0024); ?v=<version> busts caches after a change.
 * Photos are cropped square and re-encoded in the browser, which also drops
 * EXIF data (location, device) before anything is uploaded.
 * ========================================================================== */
import { config } from "./config.js";
import { escapeHtml } from "./dom.js";

export const AVATAR_BUCKET = "avatars";
export const AVATAR_SIZE = 256;
export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const AVATAR_MAX_INPUT_BYTES = 10 * 1024 * 1024; // before shrinking
export const AVATAR_MAX_UPLOAD_BYTES = 512 * 1024;      // the bucket's limit
const MAX_PIXELS = 50 * 1000 * 1000;                     // decoding more can exhaust memory on phones

/** Object path for a player's photo. */
export function avatarPath(uid) {
  return uid + "/avatar.webp";
}

/** Public URL for "<uid>/avatar.webp?v=3" (or a uid + version). */
export function avatarUrl(pathOrUid, version) {
  if (!pathOrUid || !config.supabaseUrl) return "";
  const path = version != null ? avatarPath(pathOrUid) + "?v=" + version : pathOrUid;
  return config.supabaseUrl.replace(/\/$/, "") + "/storage/v1/object/public/" + AVATAR_BUCKET + "/" + path;
}

/** Inner HTML for an .avatar circle: the photo, or the first letter. */
export function avatarInner(url, username) {
  if (url) return '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" decoding="async" />';
  return escapeHtml(((username || "?").replace(/^@/, "")[0] || "?").toUpperCase());
}

/** Why a picked file can't be used, or "" when it can. */
export function avatarFileProblem(file) {
  if (!file) return "Choose an image.";
  if (AVATAR_TYPES.indexOf(file.type) === -1) return "Use a PNG, JPG or WebP image.";
  if (file.size > AVATAR_MAX_INPUT_BYTES) return "That image is over 10 MB. Pick a smaller one.";
  return "";
}

function encode(canvas, type) {
  return new Promise(function (resolve) { canvas.toBlob(resolve, type, 0.86); });
}

/**
 * Center-crop to a square, shrink to 256 px and encode as WebP (JPEG where
 * the browser can't write WebP, e.g. Safari). Always settles.
 */
export function toAvatarBlob(file) {
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      try {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        if (!side) throw new Error("unreadable image");
        if (img.naturalWidth * img.naturalHeight > MAX_PIXELS) throw new Error("too many pixels");
        const canvas = document.createElement("canvas");
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("unreadable image");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
        encode(canvas, "image/webp")
          .then(function (blob) { return blob && blob.type === "image/webp" ? blob : encode(canvas, "image/jpeg"); })
          .then(function (blob) {
            if (!blob || AVATAR_TYPES.indexOf(blob.type) === -1) throw new Error("unreadable image");
            if (blob.size > AVATAR_MAX_UPLOAD_BYTES) throw new Error("too large");
            resolve(blob);
          })
          .catch(reject);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("unreadable image")); };
    img.src = url;
  });
}
