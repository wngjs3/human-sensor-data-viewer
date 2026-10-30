# Human Sensor Data Viewer

`s3://riselab-data-bucket/share/data/human-sensor/raw/` 데이터를 브라우저에서 바로 둘러보고 그래프로 보는 페이지입니다.

## 사용법

1. 웹사이트 접속
2. "키 붙여넣기" 칸에 본인 키를 붙여넣기 — 아래 형식 모두 인식합니다
   - `export AWS_ACCESS_KEY_ID=...` 같은 환경변수 (`env | grep AWS` 결과 그대로)
   - `~/.aws/credentials` 내용
   - `aws sts get-session-token` JSON 출력
3. **연결** → 폴더/파일 선택. 한 번 연결하면 다음부터는 자동 연결되고, 키 수정은 오른쪽 위 **⚙ 설정**에서 합니다.

- CSV / TSV / JSON / JSONL (+ `.gz`): 표 + 라인 차트
- 영상(mp4, webm, mov …) / 이미지: 바로 재생·표시
- **이미지로 보기**: 폴더마다 안에 있는 첫 영상의 첫 장면을 썸네일로 보여줘서 세션을 한눈에 구별 (마우스 올리면 미리 재생)
- 그 외 파일: 텍스트

## 키는 어디에도 전송/저장되지 않음

- 키는 브라우저 안에서 요청 서명에만 쓰이고, S3 외 다른 곳으로 보내지 않습니다.
- "이 브라우저에 키 저장"을 체크한 경우에만 본인 브라우저 localStorage에 저장됩니다. 공용 PC에서는 체크하지 마세요.
- 읽기 전용 권한(`s3:ListBucket`, `s3:GetObject`)만 있는 키 사용을 권장합니다.

## 버킷 CORS 설정 (관리자 1회)

브라우저에서 S3를 직접 호출하므로 버킷에 CORS 설정이 필요합니다.
S3 콘솔 → `riselab-data-bucket` → 권한 → CORS:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["https://wngjs3.github.io", "http://localhost:4180"],
    "ExposeHeaders": ["x-amz-bucket-region"]
  }
]
```

## 로컬 실행

```bash
python3 -m http.server 4180
```
