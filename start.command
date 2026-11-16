#!/bin/bash
# 더블클릭하면 맥에서 서버를 켜고, 아이패드에서 접속할 주소를 알려줍니다.
cd "$(dirname "$0")"
PORT=8000
IP=""
for IF in en0 en1 en2 en3 en4 en5 en6 en7 en8; do
  IP=$(ipconfig getifaddr $IF 2>/dev/null)
  [ -n "$IP" ] && break
done
echo "=============================================="
echo " 단어 스캔 학습 서버가 켜졌습니다."
echo ""
echo " 맥에서 열기     : http://localhost:$PORT"
if [ -n "$IP" ]; then
echo " 아이패드에서 열기: http://$IP:$PORT"
else
echo " (와이파이 주소를 찾지 못했어요. 맥과 아이패드를 같은 와이파이에 연결하세요)"
fi
echo ""
echo " 끄려면 이 창을 닫거나 Ctrl+C 를 누르세요."
echo "=============================================="
python3 -m http.server $PORT
