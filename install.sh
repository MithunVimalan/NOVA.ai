#!/bin/bash
# NOVA Installer Script for macOS and Linux
# Run via: curl -fsSL https://raw.githubusercontent.com/MithunVimalan/NOVA.ai/main/install.sh | bash

echo -e "\033[1;35m==========================================\033[0m"
echo -e "\033[1;35m   NOVA — NEXT-GEN AI TASK ASSISTANT      \033[0m"
echo -e "\033[1;35m==========================================\033[0m"
echo -e "\033[1;36mObedient. Local. Zero API Keys. Fully Yours.\n\033[0m"

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "\033[1;33m[Node] Node.js not found. Installing Node.js LTS...\033[0m"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS: Use Homebrew
        if ! command -v brew &> /dev/null; then
            echo "Homebrew not found. Installing Homebrew..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        brew install node
    else
        # Linux: Use Nodesource
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
else
    echo -e "\033[1;32m✓ Node.js is already installed ($(node -v))\033[0m"
fi

# 2. Check Git
if ! command -v git &> /dev/null; then
    echo -e "\033[1;33m[Git] Git not found. Installing...\033[0m"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install git
    else
        sudo apt-get install -y git
    fi
else
    echo -e "\033[1;32m✓ Git is already installed\033[0m"
fi

# 3. Check Ollama
if ! command -v ollama &> /dev/null; then
    echo -e "\033[1;33m[Ollama] Ollama not found. Installing...\033[0m"
    curl -fsSL https://ollama.ai/install.sh | sh
    ollama serve &
else
    echo -e "\033[1;32m✓ Ollama is already installed\033[0m"
    # Make sure it's running
    if ! pgrep -x "ollama" > /dev/null; then
        echo "Starting background Ollama service..."
        ollama serve &
    fi
fi

# 4. Resolve dependencies
echo -e "\n\033[1;36m[Workspace] Resolving and downloading workspace packages...\033[0m"
npx pnpm install

# 5. Compile TypeScript
echo -e "\033[1;36m[Workspace] Compiling project modules...\033[0m"
npx pnpm run build

# 6. Launch Onboarding Wizard
echo -e "\n\033[1;32mLaunching Onboarding Wizard...\033[0m"
npx pnpm run nova onboard
