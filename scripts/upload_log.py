import base64, json, urllib.request, os

token = os.environ["GH_TOKEN"]
logfile = "/tmp/build-tail.log"
content = open(logfile, "rb").read()
b64 = base64.b64encode(content).decode()
url = "https://api.github.com/repos/luokai25/kai_app/contents/ci-debug/latest.log"

sha = None
try:
    req = urllib.request.Request(
        url + "?ref=ci-logs",
        headers={"Authorization": f"token {token}", "User-Agent": "ci"},
    )
    r = urllib.request.urlopen(req)
    sha = json.loads(r.read())["sha"]
except Exception as e:
    print("no existing file:", e)

payload = {
    "message": "ci: build log " + os.environ.get("GITHUB_RUN_ID", ""),
    "content": b64,
    "branch": "ci-logs",
}
if sha:
    payload["sha"] = sha

req2 = urllib.request.Request(
    url,
    data=json.dumps(payload).encode(),
    headers={
        "Authorization": f"token {token}",
        "User-Agent": "ci",
        "Content-Type": "application/json",
    },
    method="PUT",
)
resp = urllib.request.urlopen(req2)
print(resp.status)
