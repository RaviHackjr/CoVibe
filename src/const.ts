// Shared constants extracted from google.colab v0.9.7 bundle (same as raw/colab_*.py)
// OAuth credentials live in ./secrets.ts (gitignored; see secrets.example.ts)
export { CLIENT_ID, CLIENT_SECRET } from "./secrets";

export const AUTH_URL_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const AUTH_SUCCESS_REDIRECT = "https://colab.research.google.com/vscode/auth-success";
export const COLAB_API = "https://colaboratory.googleapis.com";
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const DRIVE_FOLDER_NAME = "ColabPipe";
export const X_RUNTIME_TOKEN = "X-Colab-Runtime-Proxy-Token";
export const XSSI_GUARD = ")]}'";

export const EXT_HEADERS: Record<string, string> = {
  "X-Colab-Client-Agent": "vscode",
  "X-Colab-VS-Code-App-Name": "Visual Studio Code",
  "X-Colab-VS-Code-Extension-Version": "0.9.7",
};

export const SCOPES = [
  "profile",
  "email",
  "https://www.googleapis.com/auth/colaboratory",
  "https://www.googleapis.com/auth/drive.file",
];

export const LANG_TEMPLATES: Record<string, string> = {
  py: "python3 -u {src}",
  js: "node {src}",
  mjs: "node {src}",
  sh: "bash {src}",
  go: "go run {src}",
  c: 'gcc -O2 "{src}" -o /tmp/.execrun && /tmp/.execrun',
  cpp: 'g++ -std=c++17 -O2 "{src}" -o /tmp/.execrun && /tmp/.execrun',
  cc: 'g++ -std=c++17 -O2 "{src}" -o /tmp/.execrun && /tmp/.execrun',
  rs: 'rustc -O "{src}" -o /tmp/.execrun && /tmp/.execrun',
  java: 'javac -d /tmp/.javac "{src}" && java -cp /tmp/.javac {cls}',
};

// Sync storage filenames (mount mapping uses @@ for path separator; mirrors raw/colab_pipe.py)
export const GDRIVE_HELPER_REMOTE = "/content/.gdrive_sync.py";
export const GDRIVE_TOKEN_REMOTE = "/content/.gdrive_tok.json";

export const ENCODE_PORT: Record<string, string> = {};
