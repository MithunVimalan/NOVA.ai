# NOVA Installer Script for Windows
# Run via: powershell -ExecutionPolicy Bypass -File install.ps1

Write-Host "==========================================" -ForegroundColor Magenta
Write-Host "   NOVA — NEXT-GEN AI TASK ASSISTANT      " -ForegroundColor Magenta
Write-Host "==========================================" -ForegroundColor Magenta
Write-Host "Obedient. Local. Zero API Keys. Fully Yours.`n" -ForegroundColor Cyan

# 1. Check Node.js runtime
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[Node] Node.js not found. Installing Node.js LTS via winget..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    if (-not $?) {
        Write-Host "❌ Failed to install Node.js automatically. Please download it from: https://nodejs.org" -ForegroundColor Red
        Exit
    }
    Write-Host "✓ Node.js installed successfully. Please restart your terminal if command fails next." -ForegroundColor Green
} else {
    Write-Host "✓ Node.js is already installed ($(node --version))" -ForegroundColor Green
}

# 2. Check Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "[Git] Git not found. Installing Git via winget..." -ForegroundColor Yellow
    winget install Git.Git --silent --accept-source-agreements --accept-package-agreements
    if (-not $?) {
        Write-Host "❌ Failed to install Git. Please download it from: https://git-scm.com" -ForegroundColor Red
        Exit
    }
    Write-Host "✓ Git installed successfully." -ForegroundColor Green
} else {
    Write-Host "✓ Git is already installed" -ForegroundColor Green
}

# 3. Check Ollama
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "[Ollama] Ollama not found. Installing Ollama..." -ForegroundColor Yellow
    # Download and launch Ollama installer
    $url = "https://ollama.com/download/OllamaSetup.exe"
    $output = "$env:TEMP\OllamaSetup.exe"
    Write-Host "Downloading Ollama Setup..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $url -OutFile $output
    Write-Host "Running Ollama installer (please complete the prompt windows)..." -ForegroundColor Cyan
    Start-Process -FilePath $output -Wait
    Write-Host "✓ Ollama installation complete. Starting Ollama serve..." -ForegroundColor Green
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
} else {
    Write-Host "✓ Ollama is already installed" -ForegroundColor Green
    # Ensure it's running
    if (-not (Get-Process "ollama" -ErrorAction SilentlyContinue)) {
        Write-Host "Starting background Ollama service..." -ForegroundColor Cyan
        Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    }
}

# 4. Resolve pnpm dependencies
Write-Host "`n[Workspace] Resolving and downloading workspace packages..." -ForegroundColor Cyan
powershell -ExecutionPolicy Bypass -Command "npx pnpm install"

# 5. Compile TypeScript
Write-Host "[Workspace] Compiling project modules..." -ForegroundColor Cyan
powershell -ExecutionPolicy Bypass -Command "npx pnpm run build"

# 6. Launch Onboarding Wizard
Write-Host "`nLaunching Onboarding Wizard..." -ForegroundColor Green
powershell -ExecutionPolicy Bypass -Command "npx pnpm run nova onboard"
