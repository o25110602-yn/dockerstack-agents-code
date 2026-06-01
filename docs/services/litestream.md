# Litestream services (`docker-compose/compose.auth.yml`)

## Vai trò
- Backup/replicate SQLite DB lên S3-compatible storage.
- Hỗ trợ nhiều app, mỗi app dùng file SQLite và S3 path riêng.
- Bảo vệ dữ liệu bằng restore bắt buộc trước khi app chạy ở mode deploy bình thường.

## Compose layer
- File: `docker-compose/compose.auth.yml`.
- `dc.sh` nạp layer này ngay sau `compose.core.yml` và trước ops/access/app.
- Các project sau nên giữ auth/backup layer riêng, không nhúng Tinyauth/Litestream vào `compose.apps.yml`.

## Services
### `litestream-restore`
- Image: `litestream/litestream:0.3.13`
- Profile: `litestream`
- Chạy one-shot trước `tinyauth` và `app`.
- Command: `/entrypoint.sh restore-only`.
- Nếu `LITESTREAM_INIT_MODE=false`, restore DB từ replica S3 rồi mới cho app chạy.
- Nếu restore lỗi hoặc không có replica, exit `1` để chặn app khởi động.

### `litestream`
- Image: `litestream/litestream:0.3.13`
- Profile: `litestream`
- Chạy nền `litestream replicate` sau khi restore thành công.
- Dùng cùng config `services/litestream/litestream.yml`.

## File cấu hình
- `services/litestream/litestream.yml`: khai báo danh sách SQLite DB.
- `services/litestream/entrypoint.sh`: logic init/restore/replicate.

DB hiện có:
- Tinyauth: `/data/tinyauth/${TINYAUTH_DB_FILE}` → `${LITESTREAM_TINYAUTH_S3_PATH}`.
- App mẫu: `/data/app/${LITESTREAM_APP_DB_FILE}` → `${LITESTREAM_APP_S3_PATH}`.

## ENV bắt buộc
- `ENABLE_LITESTREAM`: `true|false`, bật profile Litestream trong `dc.sh`.
- `LITESTREAM_INIT_MODE`: `true|false`.
- `LITESTREAM_REPLICATE_DBS`: danh sách DB, ví dụ `tinyauth` hoặc `tinyauth,app`.
- `LITESTREAM_S3_ENDPOINT`: endpoint S3-compatible.
- `LITESTREAM_S3_BUCKET`: bucket chứa replica.
- `LITESTREAM_S3_ACCESS_KEY_ID`: access key.
- `LITESTREAM_S3_SECRET_ACCESS_KEY`: secret key.

## ENV per DB
- `LITESTREAM_TINYAUTH_S3_PATH`: object prefix/path cho DB Tinyauth.
- `LITESTREAM_APP_DB_FILE`: tên SQLite file app mẫu.
- `LITESTREAM_APP_S3_PATH`: object prefix/path cho DB app mẫu.

## ENV tuning
- `LITESTREAM_SYNC_INTERVAL`: default `5s`, giảm mất dữ liệu tối đa khi crash.
- `LITESTREAM_SNAPSHOT_INTERVAL`: default `30m`, giảm thời gian replay WAL khi restore.
- `LITESTREAM_RETENTION`: default `48h`, giữ generation cũ trong 48 giờ.
- `LITESTREAM_RETENTION_CHECK_INTERVAL`: default `1h`.

## Cách thêm SQLite DB cho app mới
1. Mount data app vào container app và Litestream cùng một host path:

```yaml
volumes:
  - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/myapp:/data/myapp
```

2. Thêm DB vào `services/litestream/litestream.yml`:

```yaml
  - path: /data/myapp/${LITESTREAM_MYAPP_DB_FILE}
    replicas:
      - type: s3
        endpoint: ${LITESTREAM_S3_ENDPOINT}
        bucket: ${LITESTREAM_S3_BUCKET}
        path: ${LITESTREAM_MYAPP_S3_PATH}
        access-key-id: ${LITESTREAM_S3_ACCESS_KEY_ID}
        secret-access-key: ${LITESTREAM_S3_SECRET_ACCESS_KEY}
        sync-interval: ${LITESTREAM_SYNC_INTERVAL}
        snapshot-interval: ${LITESTREAM_SNAPSHOT_INTERVAL}
        retention: ${LITESTREAM_RETENTION}
        retention-check-interval: ${LITESTREAM_RETENTION_CHECK_INTERVAL}
```

3. Thêm env vào `.env.example` và `.env`:

```env
LITESTREAM_MYAPP_DB_FILE=myapp.db
LITESTREAM_MYAPP_S3_PATH=myapp/myapp.db
LITESTREAM_REPLICATE_DBS=tinyauth,myapp
```

4. Cập nhật `services/litestream/entrypoint.sh` để restore DB mới trước khi app chạy.
5. Nếu app cần restore trước khi start, thêm `depends_on.litestream-restore.condition=service_completed_successfully`.

## Quy trình triển khai an toàn
### Lần đầu tạo DB mới
1. Set `LITESTREAM_INIT_MODE=true`.
2. Deploy stack.
3. Truy cập app/Tinyauth để tạo dữ liệu ban đầu.
4. Kiểm tra `litestream` đang replicate.
5. Đổi `LITESTREAM_INIT_MODE=false`.

### Các lần deploy bình thường
1. Giữ `LITESTREAM_INIT_MODE=false`.
2. `litestream-restore` bắt buộc restore replica trước.
3. Nếu không có backup hoặc restore lỗi, app không chạy để tránh tạo DB rỗng.

## Vận hành
- Config check: `bash docker-compose/scripts/dc.sh config`.
- Logs restore/replicate: `bash docker-compose/scripts/dc.sh logs -f litestream litestream-restore`.
- Kiểm tra container: `bash docker-compose/scripts/dc.sh ps`.
- Không chạy `down -v` nếu chưa chắc replica S3 đã ổn.
