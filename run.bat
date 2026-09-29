@echo off
chcp 65001 >nul
echo ============================================
echo  批量出图引擎
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node 18 或更高版本。
  echo        下载地址: https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist config.json (
  echo [提示] 未找到 config.json，正在从模板复制...
  copy config.example.json config.json >nul
  echo.
  echo [需要操作] 请编辑 config.json 填入 baseUrl 和 apiKey，然后重新运行本脚本。
  echo.
  pause
  exit /b 1
)

echo 正在运行...
echo.
node batch.mjs
echo.
echo ============================================
echo  完成。图片在 output 目录。
echo ============================================
pause
