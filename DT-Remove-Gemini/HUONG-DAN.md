# DT Remove Gemini — tiện ích xoá logo Gemini cho Chrome

Tự động xoá logo ngôi sao ✦ của Gemini ở góc phải-dưới ảnh **mỗi khi bạn tải ảnh về**
— từ Gemini (gemini.google.com), Google Flow (flow.google.com), labs.google, AI Studio, và
tuỳ chọn cả từ các trang khác. Kèm công cụ xoá logo cho những ảnh đã tải về từ trước.

## Cài đặt

1. Mở Chrome, vào địa chỉ `chrome://extensions`
2. Bật **Chế độ dành cho nhà phát triển** (Developer mode) ở góc phải trên.
3. Bấm **Tải tiện ích đã giải nén** (Load unpacked) → chọn thư mục `Extension xoa logo gemini` này.
4. Bấm biểu tượng mảnh ghép trên thanh công cụ → ghim **DT Remove Gemini**.
5. Nếu đang mở sẵn tab Gemini / Flow thì tải lại tab đó (F5).

## Sử dụng

- **Cứ bấm Tải xuống như bình thường.** Mỗi lượt tải ảnh được giữ lại một chút (khoảng
  1–2 giây) để kiểm tra: có logo Gemini thì lưu bản đã xoá logo với **đúng tên file gốc**,
  biểu tượng tiện ích hiện dấu ✓ xanh; không có logo thì ảnh được lưu nguyên vẹn.
- **Chuột phải vào ảnh** trên Gemini / Flow → **Tải ảnh đã xoá logo Gemini**.
- **Ảnh đã tải từ trước:** bấm biểu tượng tiện ích → **Xoá logo ảnh đã tải về** →
  kéo thả một hoặc nhiều ảnh. Xoá xong là **tự lưu ngay** vào thư mục tải xuống của Chrome
  (cũng là nơi ảnh tải từ Gemini / Flow nằm), đuôi `_xoa-logo`. Bật **Thay thế ảnh gốc** nếu
  muốn ghi đè luôn lên ảnh gốc cùng tên trong thư mục đó.
- **Dán ảnh bằng Ctrl+V** trên trang công cụ (không cần kéo thả):
  - ảnh đã sao chép (chuột phải vào ảnh → *Sao chép hình ảnh*) hoặc ảnh chụp màn hình;
  - file ảnh copy trong thư mục (chọn file → Ctrl+C);
  - link ảnh `https://…` (kể cả link trang có ảnh đại diện, link Google Drive công khai), mỗi dòng một link;
  - đường dẫn file (Shift + chuột phải vào file → *Sao chép dưới dạng đường dẫn*, ví dụ
    `"C:\Users\...\anh.jpg"`). Cách này cần bật **Cho phép truy cập vào URL của tệp** trong
    `chrome://extensions` → DT Remove Gemini → **Chi tiết**.

  Nội dung dán vào chưa chạy ngay: ảnh nằm ở hàng chờ, link / đường dẫn nằm trong ô bên dưới
  vùng kéo thả (có thể dán nhiều lần, bấm × để bỏ ảnh). Bấm **Xoá logo** (hoặc Enter trong ô)
  thì mới xoá logo tất cả. Kéo thả và **Chọn ảnh xoá logo** thì chạy ngay.
- **Giữ nhãn “Tạo bằng AI”** (mặc định tắt): ảnh Gemini/Flow gốc có kèm thông tin “tạo bằng
  AI” (C2PA, IPTC, XMP) mà Facebook, Instagram đọc để gắn nhãn *Thông tin AI*. Ảnh đã được xoá
  logo là file mới nên không còn các thông tin này. Bật công tắc nếu muốn giữ lại (tiện ích chép
  lại IPTC/XMP; chữ ký C2PA không còn hợp lệ sau khi sửa ảnh nên không chép). Dấu ẩn SynthID
  trong điểm ảnh vẫn còn, và bạn vẫn nên tự ghi rõ ảnh tạo bằng AI khi người xem có thể hiểu nhầm.
- **Nhật ký gần đây** trong cửa sổ tiện ích cho biết từng lượt tải ảnh đã được xử lý ra sao
  (đã xoá logo, không có logo, hay không đọc được ảnh).
- Trong cửa sổ của biểu tượng tiện ích:
  - **Tự động xoá logo mỗi khi tải ảnh về** — bật/tắt toàn bộ chế độ tự động.
  - **Áp dụng cả với ảnh tải từ trang khác** — tắt đi nếu chỉ muốn xử lý ảnh tải từ Gemini.

Nếu Chrome đang bật “Hỏi vị trí lưu từng tệp trước khi tải xuống”, hộp thoại lưu sẽ hiện
cho bản đã xoá logo (bản gốc có logo đã bị huỷ trước đó).

## Cách hoạt động

Tiện ích chặn ở 3 tầng, nên dù Gemini kích hoạt tải ảnh theo cách nào cũng được xử lý:

1. Trong trang Gemini: ảnh gốc được làm sạch ngay khi Gemini lấy về để tải.
2. Cú click tải cuối cùng trong trang Gemini / Flow / labs.google / AI Studio.
3. Tầng tải xuống của trình duyệt: mọi lượt tải ảnh được giữ lại trước khi lưu file
   (kể cả ảnh dạng blob/data mà chỉ trang tạo ra nó mới đọc được).

Logo của Gemini là ngôi sao màu trắng phủ lên ảnh với độ mờ cố định (~30%). Tiện ích tìm
chính xác vị trí, kích thước của ngôi sao rồi **tính ngược lại điểm ảnh gốc**
(không tô mờ, không vẽ đè), nên vùng góc ảnh được khôi phục gần như nguyên bản.
Ảnh không có logo được giữ nguyên, không bị mã hoá lại.

Mọi xử lý diễn ra ngay trong trình duyệt của bạn, ảnh không được gửi đi đâu.

## Lưu ý

- Chỉ xoá logo hiển thị. Dấu thuỷ vân ẩn **SynthID** của Google vẫn còn trong ảnh.
- Ảnh JPG đã bị nén nhiều lần có thể còn vệt rất mờ ở mép logo khi phóng to.
- Nếu sau này Gemini thay đổi cách tải ảnh và chế độ tự động không còn tác dụng, công cụ
  “Xoá logo cho ảnh đã tải về” vẫn dùng được bình thường.
- Sau khi sửa mã nguồn: vào `chrome://extensions` bấm nút tải lại (↻) của tiện ích, rồi
  tải lại tab Gemini.

## Các file

| File | Vai trò |
|---|---|
| `manifest.json` | Khai báo tiện ích (Manifest V3) |
| `engine.js` | Thuật toán dò và xoá logo |
| `inject.js` | Móc vào luồng tải ảnh của trang Gemini |
| `bridge.js` | Bật/tắt, thông báo, menu chuột phải |
| `background.js` | Chặn ở tầng tải xuống, menu chuột phải, đếm số ảnh |
| `offscreen.html/js` | Trang ẩn xử lý ảnh cho tầng tải xuống |
| `popup.html/js` | Cửa sổ bật/tắt |
| `tool.html/js` | Công cụ xoá logo cho ảnh có sẵn |
