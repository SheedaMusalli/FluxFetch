@echo off
set "PATH=C:\Users\Hammad Ur Rehman\.cargo\bin;%PATH%"
echo ===================================================
echo   OmniLink: Multi-NIC Hardware Verification Test
echo ===================================================
echo.
cargo test --test multi_nic_verification -- --nocapture
pause
