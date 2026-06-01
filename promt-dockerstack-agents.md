Prompt: Repo Agent Launcher UI — Firebase Realtime Database + Git Credentials riêng + Agent Credentials riêng + TTYD Pool

Hãy triển khai module Repo Agent Launcher UI cho repo "docker-stack-template".

Mục tiêu là tạo một UI để:

1. Quản lý Git Credentials riêng.
2. Quản lý Agent Credentials riêng.
3. Fetch và lưu danh sách repo từ Git Credentials.
4. Fetch và lưu danh sách coding agents từ Agent Profiles.
5. Khi launch, user chỉ cần:
   - chọn repo;
   - chọn agent;
   - bấm Launch.
6. Hệ thống tự tìm slot "ttyd" còn free, clone/pull repo, chuẩn bị agent credential tương ứng, start "ttyd", và trả URL cho user.

Toàn bộ dữ liệu động lưu trên Firebase Realtime Database.

".env" chỉ giữ bootstrap tối thiểu:

ENABLE_REPO_AGENT=true
REPO_AGENT_MANAGER_HOST=agent.${DOMAIN}
REPO_AGENT_MANAGER_PORT=54100
REPO_AGENT_FIREBASE_DATABASE_URL=
REPO_AGENT_FIREBASE_SERVICE_ACCOUNT_BASE64=

Không lưu danh sách Git credentials, Agent credentials, repo cache, agent profiles, slot state trong ".env".

---

1. Nguyên tắc thiết kế

1.1. Git Credentials và Agent Credentials tách biệt hoàn toàn

Git Credentials

Git Credentials chỉ dùng cho:

fetch username/org/project
fetch repo list
clone repo
pull repo
push repo nếu sau này cần

Git Credentials không dùng để auth cho agent.

Lưu tại Firebase:

/repoAgent/gitCredentials

Agent Credentials

Agent Credentials chỉ dùng cho:

auth AGY / Antigravity
auth Codex
auth Claude Code
auth OpenCode
auth custom agent
chép config/auth file
chạy bootstrap script
inject env cho agent

Agent Credentials không dùng để fetch hoặc clone repo.

Lưu tại Firebase:

/repoAgent/agentCredentials

Repo Cache

Repo cache là danh sách repo đã fetch từ Git Credentials.

Lưu tại Firebase:

/repoAgent/repoCache

Agent Profiles

Agent Profiles là danh sách agent có thể chạy.

Lưu tại Firebase:

/repoAgent/agentProfiles

---

2. Admin UI Flow

Admin UI có 4 khu chính:

1. Git Credentials
2. Repository Cache
3. Agent Profiles
4. Agent Credentials

---

2.1. Admin UI — Git Credentials

Mục tiêu: thêm token/PAT để hệ thống fetch repo.

Flow:

1. Admin mở tab Git Credentials.
2. Admin chọn provider:
   - GitHub
   - Azure DevOps
   - GitLab
   - Custom Git
3. Admin dán token/PAT.
4. Admin bấm Test.
5. Backend dùng token/PAT để fetch username/account.
6. Backend fetch org/project/group.
7. Backend fetch danh sách repo.
8. Backend lưu Git Credential vào Firebase.
9. Backend lưu repo cache vào Firebase.

Git Credential object:

{
  "id": "git_001",
  "provider": "github",
  "name": "GitHub Main",
  "tokenBase64": "...",
  "username": "o22zalo",
  "orgs": ["org-a", "org-b"],
  "enabled": true,
  "createdAt": "...",
  "updatedAt": "..."
}

Repo cache object:

{
  "id": "repo_001",
  "gitCredentialId": "git_001",
  "provider": "github",
  "fullName": "o22zalo/docker-stack-template",
  "cloneUrl": "https://github.com/o22zalo/docker-stack-template.git",
  "defaultBranch": "main",
  "localPath": "/repos/github/o22zalo/docker-stack-template",
  "enabled": true,
  "favorite": false,
  "lastFetchedAt": "..."
}

Git Credentials UI cần có chức năng:

Add Git Credential
Test Credential
Fetch Account
Fetch Repositories
Research Repo lại
Disable Credential
Delete Credential

Nút Research Repo lại chạy lại đúng luồng:

Git credential đã lưu
  ↓
fetch username/account
  ↓
fetch org/project/group
  ↓
fetch repo list
  ↓
update repo cache trên Firebase

---

2.2. Admin UI — Repository Cache

Mục tiêu: quản lý danh sách repo đã fetch.

Flow:

1. Admin mở Repository Cache.
2. UI load danh sách repo từ Firebase.
3. Admin có thể search/filter repo.
4. Admin có thể favorite/hide repo.
5. Admin có thể refresh repo theo Git Credential.

Repository Cache không chứa Agent Credential.

Repository Cache chỉ biết repo đó lấy từ Git Credential nào để khi clone/pull thì dùng đúng Git Credential đó.

---

2.3. Admin UI — Agent Profiles

Mục tiêu: quản lý danh sách coding agent có thể chạy.

Agent Profiles mặc định:

AGY / Antigravity
Codex
Claude Code
OpenCode
Custom Agent

Agent Profile object:

{
  "id": "agent_001",
  "name": "codex",
  "label": "Codex CLI",
  "command": "codex",
  "args": "",
  "workdir": "/workspace",
  "startMode": "shell",
  "enabled": true
}

Agent Profiles lưu tại:

/repoAgent/agentProfiles

Agent Profile không chứa repo.

Agent Profile không chứa Git Credential.

---

2.4. Admin UI — Agent Credentials

Mục tiêu: quản lý auth/config riêng cho từng coding agent.

Agent Credential có thể là:

file
script
env
capture

Type: file

Dùng để chép đè config/auth file vào container trước khi agent chạy.

Ví dụ:

{
  "id": "agent_cred_codex_001",
  "agentProfileId": "agent_001",
  "name": "Codex Default Config",
  "type": "file",
  "targetPath": "/home/coder/.codex/config.toml",
  "contentBase64": "...",
  "mode": "0600",
  "enabled": true
}

Type: script

Dùng để chạy script auth/bootstrap trước khi agent chạy.

{
  "id": "agent_cred_claude_001",
  "agentProfileId": "agent_002",
  "name": "Claude Bootstrap",
  "type": "script",
  "scriptBase64": "...",
  "enabled": true
}

Type: env

Dùng để inject env vars cho agent.

{
  "id": "agent_cred_opencode_001",
  "agentProfileId": "agent_003",
  "name": "OpenCode API Env",
  "type": "env",
  "env": {
    "OPENCODE_CONFIG": "/home/coder/.config/opencode/opencode.json"
  },
  "enabled": true
}

Type: capture

Dùng để login thủ công một lần rồi capture file auth.

Flow:

1. Admin tạo temporary ttyd session.
2. Admin login agent thủ công.
3. Admin chọn file cần capture.
4. Backend đọc file.
5. Backend lưu contentBase64 vào Firebase.
6. Lần sau launch agent sẽ tự chép file đó.

Agent Credentials lưu tại:

/repoAgent/agentCredentials

Agent Credentials chỉ liên quan đến Agent Profiles.

Agent Credentials không liên quan repo.

---

3. Launcher UI Flow

Launcher UI phải thật đơn giản.

User không cần chọn Git Credential.

User không cần chọn Agent Credential nếu agent đã có default credential.

Luồng đúng:

1. User mở Launcher.
2. UI load danh sách repo từ /repoAgent/repoCache.
3. User chọn repo.
4. UI load danh sách agent từ /repoAgent/agentProfiles.
5. User chọn agent.
6. UI tự load default Agent Credentials tương ứng agent đó.
7. User bấm Launch.
8. Backend tìm slot ttyd free.
9. Backend clone/pull repo bằng Git Credential gắn với repo cache.
10. Backend chuẩn bị Agent Credentials gắn với agent đã chọn.
11. Backend start ttyd slot.
12. UI trả URL terminal.

Tức là launch chỉ cần:

Repo + Agent

Không chọn lẫn Git Credential và Agent Credential ở màn hình launch, trừ khi bật Advanced Options.

Payload launch:

{
  "repoId": "repo_001",
  "agentProfileId": "agent_001"
}

Backend tự resolve:

repoId -> repoCache -> gitCredentialId -> dùng Git Credential để clone/pull
agentProfileId -> agentCredentials -> chép config/auth cho agent

---

4. TTYD Slot Pool

Có 100 slot:

ttyd001
ttyd002
...
ttyd100

Mỗi slot có URL cố định:

https://ttyd001.${DOMAIN}
https://ttyd002.${DOMAIN}
...
https://ttyd100.${DOMAIN}

Slot state lưu tại:

/repoAgent/ttydSlots

Slot object:

{
  "slot": "001",
  "name": "ttyd001",
  "serviceName": "ttyd-001",
  "containerName": "repo-agent-ttyd-001",
  "host": "ttyd001.example.com",
  "url": "https://ttyd001.example.com",
  "status": "free",
  "sessionId": null
}

Slot status:

free
reserved
cloning
starting
busy
stopping
error

Không start 100 containers mặc định.

Chỉ start slot khi user launch.

---

5. Launch Backend Flow

Khi nhận:

{
  "repoId": "repo_001",
  "agentProfileId": "agent_001"
}

Backend làm:

1. Load repo từ /repoAgent/repoCache/repo_001.
2. Lấy gitCredentialId từ repo.
3. Load Git Credential tương ứng.
4. Load Agent Profile.
5. Load Agent Credentials enabled của agent đó.
6. Tìm slot free trong /repoAgent/ttydSlots.
7. Reserve slot.
8. Clone/Pull repo bằng Git Credential.
9. Ghi runtime.env cho slot.
10. Materialize Agent Credentials vào slot folder.
11. Start container ttyd-xxx.
12. Update slot = busy.
13. Tạo session trong /repoAgent/sessions.
14. Trả URL slot.

Không có bước “repo cố định với agent”.

Không có bước “agent credential chọn theo repo”.

---

6. Runtime env per slot

Mỗi slot có file:

${DOCKER_VOLUMES_ROOT}/repo-agent/slots/001/runtime.env

Nội dung:

REPO_AGENT_SESSION_ID=sess_001
REPO_AGENT_SLOT=001
REPO_AGENT_REPO_ID=repo_001
REPO_AGENT_REPO_PATH=/repos/github/o22zalo/docker-stack-template
REPO_AGENT_REPO_FULL_NAME=o22zalo/docker-stack-template
REPO_AGENT_BRANCH=main
REPO_AGENT_AGENT_PROFILE_ID=agent_001
REPO_AGENT_AGENT_NAME=codex
REPO_AGENT_AGENT_COMMAND=codex
REPO_AGENT_AGENT_ARGS=
REPO_AGENT_START_MODE=shell

---

7. Agent Credential Materialization

Agent Credentials được lấy theo "agentProfileId", không theo repo.

Nếu agent credential type = "file":

contentBase64 -> decode -> write targetPath

Nếu type = "script":

scriptBase64 -> decode -> run before agent starts

Nếu type = "env":

write env vars into runtime.env

Materialized files nằm trong:

${DOCKER_VOLUMES_ROOT}/repo-agent/slots/001/injected-files

Khi close session phải xóa thư mục này.

---

8. Start TTYD

Start slot bằng:

bash docker-compose/scripts/dc.sh --profile repo-ttyd up -d --build --force-recreate ttyd-001

Không start toàn pool.

---

9. Close Session Flow

Khi user close session:

1. Backend đọc session.
2. Xác định slot.
3. Stop container.
4. Remove container.
5. Xóa injected files.
6. Reset runtime.env.
7. Update session status = closed.
8. Update slot status = free.

---

10. Firebase RTDB Paths Summary

/repoAgent/config
/repoAgent/gitCredentials
/repoAgent/gitAccounts
/repoAgent/repoCache
/repoAgent/agentProfiles
/repoAgent/agentCredentials
/repoAgent/ttydSlots
/repoAgent/sessions
/repoAgent/auditLogs

Phân tách rõ:

gitCredentials    -> chỉ phục vụ repo fetch/clone/pull
agentCredentials  -> chỉ phục vụ agent auth/config
repoCache         -> danh sách repo để Launcher chọn
agentProfiles     -> danh sách agent để Launcher chọn

---

11. Security Rules

[ ] Git Credentials và Agent Credentials lưu riêng.
[ ] Git Credentials không dùng cho Agent.
[ ] Agent Credentials không dùng cho Git clone/fetch.
[ ] Launcher chỉ cần chọn Repo + Agent.
[ ] Backend tự resolve Git Credential từ Repo.
[ ] Backend tự resolve Agent Credentials từ Agent.
[ ] Browser không đọc trực tiếp token thật.
[ ] Firebase RTDB không public.
[ ] TTYD slot đi qua Caddy + Tinyauth.
[ ] TTYD không publish host port.
[ ] Close session phải xóa injected files.

---

12. Acceptance Criteria

[ ] Admin UI thêm Git Credential và fetch repo được.
[ ] Repo cache lưu Firebase RTDB.
[ ] Admin UI thêm Agent Profile được.
[ ] Admin UI thêm Agent Credential riêng cho agent được.
[ ] Launcher chỉ cần chọn repo + agent.
[ ] Backend clone/pull repo bằng Git Credential gắn với repo.
[ ] Backend chuẩn bị auth/config bằng Agent Credentials gắn với agent.
[ ] Backend allocate slot free.
[ ] Backend start đúng ttyd slot.
[ ] URL trả về là https://ttyd001.domain.com hoặc slot tương ứng.
[ ] Close session trả slot về free.