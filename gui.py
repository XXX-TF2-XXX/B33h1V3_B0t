"""
B33h1V3_B0t GUI Wrapper
A Tkinter GUI that wraps the Node.js B33h1V3_B0t for easy configuration and control.
"""

import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
import subprocess
import threading
import json
import os
import sys
from pathlib import Path
from datetime import datetime


def get_app_dir():
    """Get the directory where the application files are located."""
    if getattr(sys, 'frozen', False):
        # Running as PyInstaller bundle - use exe directory
        return Path(sys.executable).parent.absolute()
    else:
        # Running as script - use script directory
        return Path(__file__).parent.absolute()


class BotGUI:
    """Tkinter GUI wrapper for the Node.js B33h1V3_B0t."""

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("B33h1V3_B0t V2.4 - Solana Volume Bot")
        self.root.geometry("1500x860")
        self.root.minsize(1100, 700)
        self.root.resizable(True, True)

        # Get the directory where the app files are located
        self.script_dir = get_app_dir()
        self.env_path = self.script_dir / ".env"

        self.bot_process = None
        self.output_thread = None
        self.running = False

        self.setup_styles()
        self.create_widgets()
        self.load_config()

        # Handle window close
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)

    # Hive theme: near-black panels, honey-amber accents.
    BG = "#121212"         # window
    PANEL = "#1b1b1f"      # frames
    FIELD = "#26262c"      # entry / combobox fields
    BORDER = "#3a3a42"
    TEXT = "#e8e6e3"
    MUTED = "#9a968f"
    HONEY = "#ffb300"      # accent
    HONEY_DIM = "#c98a00"
    GOOD = "#7bd88f"
    BAD = "#ff6b6b"

    def setup_styles(self):
        """Dark 'hive' theme for every ttk widget."""
        c = self
        self.root.configure(bg=c.BG)
        style = ttk.Style()
        style.theme_use("clam")  # the only built-in theme that honours custom colours everywhere

        style.configure(".", background=c.PANEL, foreground=c.TEXT, fieldbackground=c.FIELD,
                        bordercolor=c.BORDER, lightcolor=c.PANEL, darkcolor=c.PANEL,
                        troughcolor=c.BG, focuscolor=c.HONEY, insertcolor=c.TEXT,
                        selectbackground=c.HONEY_DIM, selectforeground="#000000",
                        font=("Segoe UI", 9))
        style.configure("TFrame", background=c.BG)
        style.configure("TLabel", background=c.BG, foreground=c.TEXT)
        style.configure("TLabelframe", background=c.BG, bordercolor=c.BORDER, relief="solid")
        style.configure("TLabelframe.Label", background=c.BG, foreground=c.HONEY, font=("Segoe UI", 9, "bold"))
        # Labels inside labelframes sit on the same background.
        style.configure("Title.TLabel", background=c.BG, foreground=c.HONEY, font=("Consolas", 22, "bold"), padding=(0, 0, 0, 8))
        style.configure("Subtitle.TLabel", background=c.BG, foreground=c.MUTED, font=("Segoe UI", 9))
        style.configure("Section.TLabel", background=c.BG, foreground=c.HONEY, font=("Segoe UI", 10, "bold"))
        style.configure("Status.TLabel", background=c.BG, font=("Segoe UI", 10, "bold"))
        style.configure("Volume.TLabel", background=c.BG, foreground=c.HONEY, font=("Consolas", 20, "bold"))

        style.configure("TEntry", fieldbackground=c.FIELD, foreground=c.TEXT, insertcolor=c.HONEY,
                        bordercolor=c.BORDER, lightcolor=c.FIELD, darkcolor=c.FIELD, padding=4)
        style.map("TEntry",
                  fieldbackground=[("disabled", c.PANEL)], foreground=[("disabled", c.MUTED)],
                  bordercolor=[("focus", c.HONEY)], lightcolor=[("focus", c.HONEY)])

        style.configure("TCombobox", fieldbackground=c.FIELD, background=c.FIELD, foreground=c.TEXT,
                        arrowcolor=c.HONEY, bordercolor=c.BORDER, lightcolor=c.FIELD, darkcolor=c.FIELD, padding=3)
        style.map("TCombobox",
                  fieldbackground=[("readonly", c.FIELD), ("disabled", c.PANEL)],
                  foreground=[("readonly", c.TEXT), ("disabled", c.MUTED)],
                  selectbackground=[("readonly", c.FIELD)], selectforeground=[("readonly", c.TEXT)],
                  bordercolor=[("focus", c.HONEY)], arrowcolor=[("disabled", c.MUTED)])
        # The dropdown list is a plain Tk listbox.
        self.root.option_add("*TCombobox*Listbox.background", c.FIELD)
        self.root.option_add("*TCombobox*Listbox.foreground", c.TEXT)
        self.root.option_add("*TCombobox*Listbox.selectBackground", c.HONEY)
        self.root.option_add("*TCombobox*Listbox.selectForeground", "#000000")

        style.configure("TCheckbutton", background=c.BG, foreground=c.TEXT, indicatorcolor=c.FIELD)
        style.map("TCheckbutton", indicatorcolor=[("selected", c.HONEY)], background=[("active", c.BG)])

        style.configure("TButton", background=c.FIELD, foreground=c.TEXT, bordercolor=c.BORDER,
                        lightcolor=c.FIELD, darkcolor=c.FIELD, padding=(10, 6), font=("Segoe UI", 10, "bold"))
        style.map("TButton",
                  background=[("disabled", c.PANEL), ("pressed", c.HONEY_DIM), ("active", c.BORDER)],
                  foreground=[("disabled", c.MUTED)])
        style.configure("Start.TButton", background=c.HONEY, foreground="#000000", font=("Segoe UI", 11, "bold"))
        style.map("Start.TButton",
                  background=[("disabled", c.PANEL), ("pressed", c.HONEY_DIM), ("active", "#ffc94d")],
                  foreground=[("disabled", c.MUTED)])
        style.configure("Stop.TButton", background="#5c1f1f", foreground=c.TEXT, font=("Segoe UI", 11, "bold"))
        style.map("Stop.TButton",
                  background=[("disabled", c.PANEL), ("pressed", "#3d1515"), ("active", "#7a2a2a")],
                  foreground=[("disabled", c.MUTED)])

        style.configure("Vertical.TScrollbar", background=c.FIELD, troughcolor=c.BG, arrowcolor=c.HONEY, bordercolor=c.BG)

    def create_widgets(self):
        """Create all GUI widgets."""
        # Main container with padding
        main_frame = ttk.Frame(self.root, padding="12")
        main_frame.grid(row=0, column=0, sticky="nsew")

        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        main_frame.columnconfigure(1, weight=1)   # right column (log) takes the spare width
        main_frame.rowconfigure(0, weight=1)

        # Left: settings + controls.  Right: live stats + log (same screen).
        left = ttk.Frame(main_frame)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 12))
        left.columnconfigure(0, weight=1)
        right = ttk.Frame(main_frame)
        right.grid(row=0, column=1, sticky="nsew")
        right.columnconfigure(0, weight=1)

        # Title
        title_label = ttk.Label(left, text="B33h1V3_B0t", style="Title.TLabel")
        title_label.grid(row=0, column=0, columnspan=2)
        ttk.Label(left, text="open-source Solana volume bot  |  every wallet drained to zero  |  no hidden fees",
                  style="Subtitle.TLabel").grid(row=1, column=0, columnspan=2, pady=(0, 10))

        row = 2

        # ========== CONNECTION SETTINGS ==========
        conn_frame = ttk.LabelFrame(left, text="Connection Settings", padding="8")
        conn_frame.grid(row=row, column=0, columnspan=2, sticky="ew", pady=(0, 8))
        conn_frame.columnconfigure(1, weight=1)
        row += 1

        # Jupiter API Key
        ttk.Label(conn_frame, text="Jupiter API Key (optional):").grid(row=0, column=0, sticky="w", pady=3)
        self.jupiter_key_entry = ttk.Entry(conn_frame, width=56)
        self.jupiter_key_entry.grid(row=0, column=1, sticky="ew", pady=3, padx=(10, 0))

        # RPC Endpoint
        ttk.Label(conn_frame, text="RPC Endpoint:").grid(row=1, column=0, sticky="w", pady=3)
        self.rpc_entry = ttk.Entry(conn_frame, width=56)
        self.rpc_entry.grid(row=1, column=1, sticky="ew", pady=3, padx=(10, 0))

        # ========== WALLET SETTINGS ==========
        wallet_frame = ttk.LabelFrame(left, text="Wallet Settings", padding="8")
        wallet_frame.grid(row=row, column=0, columnspan=2, sticky="ew", pady=(0, 8))
        wallet_frame.columnconfigure(1, weight=1)
        row += 1

        # Private Key
        ttk.Label(wallet_frame, text="Private Key (Base58):").grid(row=0, column=0, sticky="w", pady=3)
        key_container = ttk.Frame(wallet_frame)
        key_container.grid(row=0, column=1, sticky="ew", pady=3, padx=(10, 0))
        key_container.columnconfigure(0, weight=1)

        self.key_entry = ttk.Entry(key_container, width=48, show="*")
        self.key_entry.grid(row=0, column=0, sticky="ew")

        self.show_key_var = tk.BooleanVar(value=False)
        show_key_btn = ttk.Checkbutton(key_container, text="Show", variable=self.show_key_var,
                                       command=self.toggle_key_visibility)
        show_key_btn.grid(row=0, column=1, padx=(10, 0))

        # Token Address
        ttk.Label(wallet_frame, text="Token to Trade (Mint):").grid(row=1, column=0, sticky="w", pady=3)
        self.token_entry = ttk.Entry(wallet_frame, width=56)
        self.token_entry.grid(row=1, column=1, sticky="ew", pady=3, padx=(10, 0))

        # ========== TRANSACTION SETTINGS ==========
        tx_frame = ttk.LabelFrame(left, text="Transaction Settings", padding="8")
        tx_frame.grid(row=row, column=0, columnspan=2, sticky="ew", pady=(0, 8))
        row += 1

        # Row 1: Min/Max Buy
        ttk.Label(tx_frame, text="Min Buy (SOL):").grid(row=0, column=0, sticky="w", pady=3)
        self.min_buy_entry = ttk.Entry(tx_frame, width=12)
        self.min_buy_entry.grid(row=0, column=1, sticky="w", pady=3, padx=(5, 18))

        ttk.Label(tx_frame, text="Max Buy (SOL):").grid(row=0, column=2, sticky="w", pady=3)
        self.max_buy_entry = ttk.Entry(tx_frame, width=12)
        self.max_buy_entry.grid(row=0, column=3, sticky="w", pady=3, padx=(5, 18))

        ttk.Label(tx_frame, text="Delay (sec):").grid(row=0, column=4, sticky="w", pady=3)
        self.delay_entry = ttk.Entry(tx_frame, width=8)
        self.delay_entry.grid(row=0, column=5, sticky="w", pady=3, padx=(5, 0))

        # Row 2: Concurrency / Max Priority Fee / Wallet Buffer
        ttk.Label(tx_frame, text="Recyclers (at once):").grid(row=1, column=0, sticky="w", pady=3)
        self.concurrency_entry = ttk.Entry(tx_frame, width=12)
        self.concurrency_entry.grid(row=1, column=1, sticky="w", pady=3, padx=(5, 18))

        ttk.Label(tx_frame, text="Max Priority Fee:").grid(row=1, column=2, sticky="w", pady=3)
        self.priority_fee_entry = ttk.Entry(tx_frame, width=12)
        self.priority_fee_entry.grid(row=1, column=3, sticky="w", pady=3, padx=(5, 18))

        ttk.Label(tx_frame, text="Wallet Buffer:").grid(row=1, column=4, sticky="w", pady=3)
        self.sol_transfer_entry = ttk.Entry(tx_frame, width=8)
        self.sol_transfer_entry.grid(row=1, column=5, sticky="w", pady=3, padx=(5, 0))

        # Row 3: Slippage / Priority Level
        ttk.Label(tx_frame, text="Max Slippage (%):").grid(row=2, column=0, sticky="w", pady=3)
        self.slippage_entry = ttk.Entry(tx_frame, width=12)
        self.slippage_entry.grid(row=2, column=1, sticky="w", pady=3, padx=(5, 18))

        ttk.Label(tx_frame, text="Priority Level:").grid(row=2, column=2, sticky="w", pady=3)
        self.priority_level_combo = ttk.Combobox(tx_frame, width=10, state="readonly",
                                                  values=["low", "medium", "high", "veryHigh"])
        self.priority_level_combo.grid(row=2, column=3, sticky="w", pady=3, padx=(5, 18))

        # Row 4: Swap Engine / Sender mode / Sender region (speed + landing)
        ttk.Label(tx_frame, text="Swap Engine:").grid(row=3, column=0, sticky="w", pady=3)
        self.engine_combo = ttk.Combobox(tx_frame, width=10, state="readonly",
                                         values=["auto", "pumpswap", "jupiter"])
        self.engine_combo.grid(row=3, column=1, sticky="w", pady=3, padx=(5, 18))

        ttk.Label(tx_frame, text="Helius Sender:").grid(row=3, column=2, sticky="w", pady=3)
        self.sender_mode_combo = ttk.Combobox(tx_frame, width=10, state="readonly",
                                              values=["swqos", "max", "off"])
        self.sender_mode_combo.grid(row=3, column=3, sticky="w", pady=3, padx=(5, 18))

        ttk.Label(tx_frame, text="Region:").grid(row=3, column=4, sticky="w", pady=3)
        self.sender_region_combo = ttk.Combobox(tx_frame, width=6, state="readonly",
                                                values=["auto", "slc", "ewr", "lon", "fra", "ams", "sg", "tyo"])
        self.sender_region_combo.grid(row=3, column=5, sticky="w", pady=3, padx=(5, 0))

        # ========== VETERAN WALLETS ==========
        vet_frame = ttk.LabelFrame(left, text="Veteran Wallets (funded once, trade several times, then retire)", padding="8")
        vet_frame.grid(row=row, column=0, columnspan=2, sticky="ew", pady=(0, 8))
        row += 1

        ttk.Label(vet_frame, text="Veterans (at once):").grid(row=0, column=0, sticky="w", pady=3)
        self.vet_count_entry = ttk.Entry(vet_frame, width=8)
        self.vet_count_entry.grid(row=0, column=1, sticky="w", pady=3, padx=(5, 18))

        ttk.Label(vet_frame, text="Trades each (min / max):").grid(row=0, column=2, sticky="w", pady=3)
        vet_trades = ttk.Frame(vet_frame)
        vet_trades.grid(row=0, column=3, sticky="w", pady=3, padx=(5, 18))
        self.vet_min_trades_entry = ttk.Entry(vet_trades, width=5)
        self.vet_min_trades_entry.grid(row=0, column=0)
        ttk.Label(vet_trades, text=" / ").grid(row=0, column=1)
        self.vet_max_trades_entry = ttk.Entry(vet_trades, width=5)
        self.vet_max_trades_entry.grid(row=0, column=2)

        ttk.Label(vet_frame, text="Hold %:").grid(row=0, column=4, sticky="w", pady=3)
        self.vet_hold_entry = ttk.Entry(vet_frame, width=6)
        self.vet_hold_entry.grid(row=0, column=5, sticky="w", pady=3, padx=(5, 0))

        ttk.Label(vet_frame, text="Wait between visits, sec (min / max):").grid(row=1, column=0, columnspan=3, sticky="w", pady=3)
        vet_wait = ttk.Frame(vet_frame)
        vet_wait.grid(row=1, column=3, sticky="w", pady=3, padx=(5, 18))
        self.vet_wait_min_entry = ttk.Entry(vet_wait, width=5)
        self.vet_wait_min_entry.grid(row=0, column=0)
        ttk.Label(vet_wait, text=" / ").grid(row=0, column=1)
        self.vet_wait_max_entry = ttk.Entry(vet_wait, width=5)
        self.vet_wait_max_entry.grid(row=0, column=2)

        # ========== CONTROL BUTTONS ==========
        btn_frame = ttk.Frame(left)
        btn_frame.grid(row=row, column=0, columnspan=2, pady=(6, 4))
        row += 1

        self.save_btn = ttk.Button(btn_frame, text="Save Config", command=self.save_config, width=13)
        self.save_btn.grid(row=0, column=0, padx=6)

        self.start_btn = ttk.Button(btn_frame, text="Start Bot", command=self.start_bot,
                                    style="Start.TButton", width=13)
        self.start_btn.grid(row=0, column=1, padx=6)

        self.stop_btn = ttk.Button(btn_frame, text="Stop Bot", command=self.stop_bot,
                                   style="Stop.TButton", width=15, state="disabled")
        self.stop_btn.grid(row=0, column=2, padx=6)

        self.recover_btn = ttk.Button(btn_frame, text="Recover Funds", command=self.recover_funds,
                                      width=13)
        self.recover_btn.grid(row=0, column=3, padx=6)

        # ========== STATUS ==========
        status_frame = ttk.Frame(left)
        status_frame.grid(row=row, column=0, columnspan=2, pady=(2, 0))
        row += 1

        self.status_var = tk.StringVar(value="Status: Stopped")
        self.status_label = ttk.Label(status_frame, textvariable=self.status_var,
                                      style="Status.TLabel", foreground=self.MUTED)
        self.status_label.grid(row=0, column=0)

        # ========== THIS RUN (live stats) ==========
        stats_frame = ttk.LabelFrame(right, text="This Run", padding="8")
        stats_frame.grid(row=0, column=0, sticky="ew", pady=(6, 6))
        stats_frame.columnconfigure(0, weight=1)
        stats_frame.columnconfigure(1, weight=1)

        self.volume_var = tk.StringVar(value="0.0000 SOL")
        ttk.Label(stats_frame, text="Total Volume:", style="Section.TLabel").grid(row=0, column=0, sticky="e", padx=(0, 6))
        ttk.Label(stats_frame, textvariable=self.volume_var, style="Volume.TLabel").grid(row=0, column=1, sticky="w")

        self.stats_detail_var = tk.StringVar(value="Swaps: 0  |  Run time: 0:00:00  |  Volume/hour: -  |  Spent so far: -")
        ttk.Label(stats_frame, textvariable=self.stats_detail_var, style="Subtitle.TLabel").grid(
            row=1, column=0, columnspan=2, pady=(4, 0))

        self.run_started_at = None
        self.last_stats = {}

        # ========== LOG OUTPUT ==========
        ttk.Label(right, text="Bot Output", style="Section.TLabel").grid(
            row=1, column=0, sticky="w", pady=(4, 4))

        # Log: terminal look, colour-coded by level
        self.log_text = scrolledtext.ScrolledText(
            right, height=30, width=90,
            font=("Consolas", 9),
            bg="#0b0b0d", fg="#cfcac2",
            insertbackground=self.HONEY, selectbackground=self.HONEY_DIM,
            relief="flat", borderwidth=0, highlightthickness=1,
            highlightbackground=self.BORDER, highlightcolor=self.HONEY,
        )
        self.log_text.tag_configure("SUCCESS", foreground=self.GOOD)
        self.log_text.tag_configure("WARN", foreground=self.HONEY)
        self.log_text.tag_configure("ERROR", foreground=self.BAD)
        self.log_text.tag_configure("REPORT", foreground="#ffd36b")
        self.log_text.vbar.configure(bg=self.FIELD, troughcolor="#0b0b0d", activebackground=self.HONEY,
                                     relief="flat", borderwidth=0)
        self.log_text.grid(row=2, column=0, sticky="nsew")
        right.rowconfigure(2, weight=1)

        # Clear log button
        clear_btn = ttk.Button(right, text="Clear Log", command=self.clear_log, width=12)
        clear_btn.grid(row=3, column=0, sticky="e", pady=(6, 0))

    def toggle_key_visibility(self):
        """Toggle private key visibility."""
        if self.show_key_var.get():
            self.key_entry.configure(show="")
        else:
            self.key_entry.configure(show="*")

    def log(self, message: str, level: str = "INFO"):
        """Add message to log output with timestamp."""
        timestamp = datetime.now().strftime("%H:%M:%S")

        self.insert_line(f"[{timestamp}] {message}\n", level)

    def insert_line(self, line: str, level: str = None):
        """Append one line to the log, coloured by its level."""
        if level is None:
            if "[ERROR]" in line:
                level = "ERROR"
            elif "[WARN]" in line:
                level = "WARN"
            elif "[SUCCESS]" in line:
                level = "SUCCESS"
            elif "SESSION REPORT" in line or "Cost per swap" in line or "Swaps:" in line:
                level = "REPORT"
        tags = (level,) if level in ("ERROR", "WARN", "SUCCESS", "REPORT") else ()
        self.log_text.insert(tk.END, line, tags)
        self.log_text.see(tk.END)

    def clear_log(self):
        """Clear the log output."""
        self.log_text.delete(1.0, tk.END)

    def load_config(self):
        """Load configuration from .env file."""
        if self.env_path.exists():
            config = {}
            with open(self.env_path, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        key, _, value = line.partition('=')
                        config[key.strip()] = value.strip()

            self.jupiter_key_entry.insert(0, config.get('JUPITER_API_KEY', ''))
            self.rpc_entry.insert(0, config.get('RPC_ENDPOINT', ''))
            self.key_entry.insert(0, config.get('KEY', ''))
            self.token_entry.insert(0, config.get('TOKEN_ADDRESS', ''))
            self.min_buy_entry.insert(0, config.get('MIN_BUY_AMOUNT', '0.005'))
            self.max_buy_entry.insert(0, config.get('MAX_BUY_AMOUNT', '0.008'))
            self.concurrency_entry.insert(0, config.get('WALLET_CONCURRENCY', '2'))
            self.priority_fee_entry.insert(0, config.get('PRIORITY_FEE', '0.0005'))
            self.priority_level_combo.set(config.get('PRIORITY_LEVEL', 'low'))
            self.sol_transfer_entry.insert(0, config.get('SOL_TRANSFER_AMOUNT', '0.01'))
            self.delay_entry.insert(0, config.get('DELAY', '2'))
            self.engine_combo.set(config.get('SWAP_ENGINE', 'auto'))
            self.sender_mode_combo.set(config.get('SENDER_MODE', 'off'))
            self.sender_region_combo.set(config.get('SENDER_REGION', 'auto'))
            self.vet_count_entry.insert(0, config.get('VETERAN_WALLETS', '1'))
            self.vet_min_trades_entry.insert(0, config.get('VETERAN_MIN_TRADES', '3'))
            self.vet_max_trades_entry.insert(0, config.get('VETERAN_MAX_TRADES', '8'))
            self.vet_hold_entry.insert(0, config.get('VETERAN_HOLD_PCT', '50'))
            self.vet_wait_min_entry.insert(0, config.get('VETERAN_WAIT_MIN', '10'))
            self.vet_wait_max_entry.insert(0, config.get('VETERAN_WAIT_MAX', '60'))
            # Stored as basis points in .env; shown as a percentage in the GUI.
            try:
                slippage_pct = round(float(config.get('SLIPPAGE_BPS', '700')) / 100, 2)
            except ValueError:
                slippage_pct = 7
            self.slippage_entry.insert(0, str(slippage_pct))

            self.log("Configuration loaded from .env")
        else:
            # Set defaults
            self.min_buy_entry.insert(0, '0.005')
            self.max_buy_entry.insert(0, '0.008')
            self.concurrency_entry.insert(0, '2')
            self.priority_fee_entry.insert(0, '0.0005')
            self.priority_level_combo.set('low')
            self.sol_transfer_entry.insert(0, '0.01')
            self.slippage_entry.insert(0, '7')
            self.delay_entry.insert(0, '2')
            self.engine_combo.set('auto')
            self.sender_mode_combo.set('off')
            self.sender_region_combo.set('auto')
            self.vet_count_entry.insert(0, '1')
            self.vet_min_trades_entry.insert(0, '3')
            self.vet_max_trades_entry.insert(0, '8')
            self.vet_hold_entry.insert(0, '50')
            self.vet_wait_min_entry.insert(0, '10')
            self.vet_wait_max_entry.insert(0, '60')
            self.log("No .env found, using defaults")

    def get_config(self) -> dict:
        """Get current configuration from GUI fields."""
        # Slippage is entered as a percent but stored as basis points.
        try:
            slippage_bps = str(int(round(float(self.slippage_entry.get().strip()) * 100)))
        except ValueError:
            slippage_bps = '700'
        return {
            'JUPITER_API_KEY': self.jupiter_key_entry.get().strip(),
            'RPC_ENDPOINT': self.rpc_entry.get().strip(),
            'KEY': self.key_entry.get().strip(),
            'TOKEN_ADDRESS': self.token_entry.get().strip(),
            'MIN_BUY_AMOUNT': self.min_buy_entry.get().strip(),
            'MAX_BUY_AMOUNT': self.max_buy_entry.get().strip(),
            'WALLET_CONCURRENCY': self.concurrency_entry.get().strip() or '2',
            'PRIORITY_FEE': self.priority_fee_entry.get().strip(),
            'PRIORITY_LEVEL': self.priority_level_combo.get().strip() or 'low',
            'SOL_TRANSFER_AMOUNT': self.sol_transfer_entry.get().strip(),
            'SLIPPAGE_BPS': slippage_bps,
            'DELAY': self.delay_entry.get().strip(),
            'SWAP_ENGINE': self.engine_combo.get().strip() or 'auto',
            'SENDER_MODE': self.sender_mode_combo.get().strip() or 'off',
            'SENDER_REGION': self.sender_region_combo.get().strip() or 'auto',
            'VETERAN_WALLETS': self.vet_count_entry.get().strip() or '0',
            'VETERAN_MIN_TRADES': self.vet_min_trades_entry.get().strip() or '3',
            'VETERAN_MAX_TRADES': self.vet_max_trades_entry.get().strip() or '8',
            'VETERAN_HOLD_PCT': self.vet_hold_entry.get().strip() or '50',
            'VETERAN_WAIT_MIN': self.vet_wait_min_entry.get().strip() or '10',
            'VETERAN_WAIT_MAX': self.vet_wait_max_entry.get().strip() or '60',
        }

    def save_config(self):
        """Save configuration to .env file."""
        config = self.get_config()

        env_content = f"""# ============================================================
# B33H1V3_B0T CONFIGURATION
# ============================================================

# Jupiter API Key (OPTIONAL — blank uses the free lite-api tier).
# Get a key for higher rate limits at https://developers.jup.ag/portal
JUPITER_API_KEY={config['JUPITER_API_KEY']}

# Solana RPC Endpoint (get from Helius, QuickNode, Alchemy, etc.)
RPC_ENDPOINT={config['RPC_ENDPOINT']}

# Wallet Private Key (Base58 encoded)
# WARNING: Keep this secret!
KEY={config['KEY']}

# Target token mint address to trade
TOKEN_ADDRESS={config['TOKEN_ADDRESS']}

# ============================================================
# TRANSACTION SETTINGS
# ============================================================

# Buy amount range per cycle (in SOL)
MIN_BUY_AMOUNT={config['MIN_BUY_AMOUNT']}
MAX_BUY_AMOUNT={config['MAX_BUY_AMOUNT']}

# RECYCLERS: how many fresh-wallet-per-trade workers run at once (0-10).
WALLET_CONCURRENCY={config['WALLET_CONCURRENCY']}

# Max priority fee CAP per transaction (in SOL). Fees are DYNAMIC — the bot
# pays the real-time rate for PRIORITY_LEVEL on the exact accounts it touches,
# never exceeding this cap, and escalates one level per retry if a tx expires.
PRIORITY_FEE={config['PRIORITY_FEE']}

# Starting priority level: low | medium | high | veryHigh  (low = cheapest)
PRIORITY_LEVEL={config['PRIORITY_LEVEL']}

# Extra SOL sent to each fresh trading wallet to cover fees + token-account
# rent. It is fully swept back when the wallet is drained, so this only sets
# how much floats temporarily, not a cost.
SOL_TRANSFER_AMOUNT={config['SOL_TRANSFER_AMOUNT']}

# Max slippage tolerance, in basis points (700 = 7%).
SLIPPAGE_BPS={config['SLIPPAGE_BPS']}

# Delay between cycles, per worker (in seconds)
DELAY={config['DELAY']}

# ============================================================
# SPEED & LANDING
# ============================================================

# Swap engine: auto (direct PumpSwap when the token's pool exists, else
# Jupiter) | pumpswap | jupiter
SWAP_ENGINE={config['SWAP_ENGINE']}

# Helius Sender (free, no plan needed): swqos (staked fast path, 0.000005 SOL
# tip per tx) | max (all pathways incl. Jito, 0.001 SOL tip) | off (plain RPC
# only: no tip, lowest fees, lands a little slower)
SENDER_MODE={config['SENDER_MODE']}

# Sender region nearest this machine: auto | slc | ewr | lon | fra | ams | sg | tyo
SENDER_REGION={config['SENDER_REGION']}

# ============================================================
# VETERAN WALLETS
# ============================================================

# Veterans are funded once, trade several times with random waits, then are
# drained to zero and retired like every wallet. Each visit is a buy+sell, or
# a buy held until the next visit (VETERAN_HOLD_PCT chance), or the sell of
# what it held. 1-2 transactions per visit instead of a recycler's 4.
VETERAN_WALLETS={config['VETERAN_WALLETS']}
VETERAN_MIN_TRADES={config['VETERAN_MIN_TRADES']}
VETERAN_MAX_TRADES={config['VETERAN_MAX_TRADES']}
VETERAN_HOLD_PCT={config['VETERAN_HOLD_PCT']}
VETERAN_WAIT_MIN={config['VETERAN_WAIT_MIN']}
VETERAN_WAIT_MAX={config['VETERAN_WAIT_MAX']}
"""

        with open(self.env_path, 'w', encoding='utf-8') as f:
            f.write(env_content)

        self.log("Configuration saved to .env", "SUCCESS")
        messagebox.showinfo("Success", "Configuration saved successfully!")

    def validate_config(self) -> bool:
        """Validate configuration before starting."""
        config = self.get_config()

        # Jupiter API key is optional — without it the bot uses the free
        # lite-api.jup.ag tier (lower rate limits).
        if not config['RPC_ENDPOINT']:
            messagebox.showerror("Error", "RPC Endpoint is required!")
            return False
        if not config['KEY']:
            messagebox.showerror("Error", "Wallet Private Key is required!")
            return False
        if not config['TOKEN_ADDRESS']:
            messagebox.showerror("Error", "Token Address is required!")
            return False

        try:
            min_buy = float(config['MIN_BUY_AMOUNT'])
            max_buy = float(config['MAX_BUY_AMOUNT'])
            if min_buy >= max_buy:
                messagebox.showerror("Error", "Min Buy must be less than Max Buy!")
                return False
        except ValueError:
            messagebox.showerror("Error", "Invalid buy amount values!")
            return False

        try:
            recyclers = int(config['WALLET_CONCURRENCY'])
            vets = int(config['VETERAN_WALLETS'])
            vmin, vmax = int(config['VETERAN_MIN_TRADES']), int(config['VETERAN_MAX_TRADES'])
            hold = int(config['VETERAN_HOLD_PCT'])
            wmin, wmax = int(config['VETERAN_WAIT_MIN']), int(config['VETERAN_WAIT_MAX'])
        except ValueError:
            messagebox.showerror("Error", "Recyclers and all Veteran fields must be whole numbers!")
            return False
        if recyclers < 0 or vets < 0 or recyclers + vets == 0:
            messagebox.showerror("Error", "Set Recyclers and/or Veterans above 0!")
            return False
        if vmin < 1 or vmax < vmin:
            messagebox.showerror("Error", "Veteran trades: min must be at least 1 and max at least min!")
            return False
        if not 0 <= hold <= 100:
            messagebox.showerror("Error", "Hold % must be between 0 and 100!")
            return False
        if wmin < 0 or wmax < wmin:
            messagebox.showerror("Error", "Veteran wait: min must be 0 or more and max at least min!")
            return False

        return True

    def start_bot(self):
        """Start the Node.js bot as a subprocess."""
        if not self.validate_config():
            return

        # Save config first
        self.save_config()

        self.log("Starting bot...", "INFO")

        try:
            # Start the Node.js process
            self.bot_process = subprocess.Popen(
                ["node", "index.js"],
                cwd=str(self.script_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                creationflags=(subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP) if sys.platform == "win32" else 0
            )

            self.running = True
            self.reset_stats()
            self.root.after(1000, self.tick_stats)

            # Start thread to read output
            self.output_thread = threading.Thread(target=self.read_output, daemon=True)
            self.output_thread.start()

            # Update UI
            self.start_btn.configure(state="disabled")
            self.stop_btn.configure(state="normal")
            self.save_btn.configure(state="disabled")
            self.status_var.set("Status: Running")
            self.status_label.configure(foreground=self.GOOD)
            self.disable_entries()

        except FileNotFoundError:
            self.log("ERROR: Node.js not found! Please install Node.js.", "ERROR")
            messagebox.showerror("Error", "Node.js is not installed or not in PATH.\n\nPlease install Node.js from https://nodejs.org/")
        except Exception as e:
            self.log(f"ERROR: Failed to start bot: {str(e)}", "ERROR")
            messagebox.showerror("Error", f"Failed to start bot:\n{str(e)}")

    # ---------- live "This Run" stats ----------
    def reset_stats(self):
        self.run_started_at = datetime.now()
        self.last_stats = {}
        self.volume_var.set("0.0000 SOL")
        self.refresh_stats()

    def apply_stats(self, payload: str):
        try:
            self.last_stats = json.loads(payload)
        except ValueError:
            return
        self.refresh_stats()

    def refresh_stats(self):
        s = self.last_stats
        vol = float(s.get('volumeSol') or 0)
        self.volume_var.set(f"{vol:.4f} SOL")
        elapsed = (datetime.now() - self.run_started_at).total_seconds() if self.run_started_at else 0
        h, rem = divmod(int(elapsed), 3600)
        m, sec = divmod(rem, 60)
        per_hour = f"{vol / (elapsed / 3600):.2f} SOL" if elapsed >= 60 and vol > 0 else "-"
        spent = s.get('spentSol')
        spent_txt = f"~{spent:.4f} SOL" if isinstance(spent, (int, float)) else "-"
        swaps = int(s.get('buys') or 0) + int(s.get('sells') or 0)
        self.stats_detail_var.set(
            f"Swaps: {swaps} ({s.get('buys', 0)} buys / {s.get('sells', 0)} sells)  |  "
            f"Run time: {h}:{m:02d}:{sec:02d}  |  Volume/hour: {per_hour}  |  Spent so far: {spent_txt}")

    def tick_stats(self):
        if self.running:
            self.refresh_stats()
            self.root.after(1000, self.tick_stats)

    def read_output(self):
        """Read output from the bot process."""
        try:
            for line in self.bot_process.stdout:
                if not self.running:
                    break
                if line.startswith('@@STATS '):
                    self.root.after(0, lambda p=line[8:]: self.apply_stats(p))
                    continue
                # Schedule GUI update from main thread
                self.root.after(0, lambda l=line: self.insert_line(l))
                self.root.after(0, lambda: self.log_text.see(tk.END))
        except Exception as e:
            if self.running:
                self.root.after(0, lambda: self.log(f"Output error: {str(e)}", "ERROR"))

        # Process ended
        if self.running:
            self.root.after(0, self.on_bot_stopped)

    def stop_bot(self):
        """Stop the running bot with graceful shutdown."""
        self.log("Initiating graceful shutdown...", "WARN")
        self.log("Please wait while wallets are cleaned up...", "WARN")

        # Update UI to show shutting down state
        self.status_var.set("Status: Shutting Down...")
        self.status_label.configure(foreground=self.HONEY)
        self.stop_btn.configure(state="disabled")

        # Create shutdown file to signal the bot
        shutdown_file = self.script_dir / ".shutdown"
        try:
            with open(shutdown_file, 'w') as f:
                f.write("shutdown")
            self.log("Shutdown signal sent to bot...", "WARN")
        except Exception as e:
            self.log(f"Failed to create shutdown file: {str(e)}", "ERROR")

        # Run shutdown wait in background thread to not freeze GUI
        def do_shutdown():
            if self.bot_process:
                try:
                    # Wait up to 5 minutes for graceful shutdown (every live
                    # wallet, veterans included, is sold out and drained first)
                    self.bot_process.wait(timeout=300)
                    self.root.after(0, lambda: self.log("Graceful shutdown completed!", "SUCCESS"))
                except subprocess.TimeoutExpired:
                    self.root.after(0, lambda: self.log("Shutdown timeout - force killing. Any wallet still listed is recovered on the next Start or with Recover Funds.", "ERROR"))
                    self.bot_process.kill()
                except Exception as e:
                    self.root.after(0, lambda: self.log(f"Error during shutdown: {str(e)}", "ERROR"))
                    try:
                        self.bot_process.kill()
                    except:
                        pass

            # Clean up shutdown file if it still exists
            try:
                if shutdown_file.exists():
                    shutdown_file.unlink()
            except:
                pass

            self.running = False
            self.root.after(0, self.on_bot_stopped)

        shutdown_thread = threading.Thread(target=do_shutdown, daemon=True)
        shutdown_thread.start()

    def on_bot_stopped(self):
        """Handle bot stopped state."""
        self.running = False
        self.bot_process = None

        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        self.save_btn.configure(state="normal")
        self.status_var.set("Status: Stopped")
        self.status_label.configure(foreground=self.MUTED)
        self.enable_entries()

        self.log("Bot stopped", "WARN")

    def recover_funds(self):
        """Run the fund recovery script to sweep funds from abandoned wallets."""
        if self.running:
            messagebox.showerror("Error", "Cannot recover funds while bot is running.\nStop the bot first.")
            return

        # Check if recovery script exists
        recover_script = self.script_dir / "recover.js"
        if not recover_script.exists():
            messagebox.showerror("Error", "recover.js not found!")
            return

        # Check if there are wallets to recover
        wallets_file = self.script_dir / "active_wallets.json"
        if not wallets_file.exists():
            messagebox.showinfo("Info", "No active_wallets.json found.\n\nThis file is created when the bot runs.\nIf there are no stuck funds, this is normal.")
            return

        # Confirm with user
        if not messagebox.askyesno("Recover Funds",
            "This will attempt to recover all funds from trading wallets.\n\n"
            "It will:\n"
            "- Sell any remaining tokens\n"
            "- Close token accounts\n"
            "- Sweep all SOL back to main wallet\n\n"
            "Continue?"):
            return

        self.log("Starting fund recovery...", "WARN")
        self.status_var.set("Status: Recovering Funds...")
        self.status_label.configure(foreground=self.HONEY)
        self.recover_btn.configure(state="disabled")

        def run_recovery():
            try:
                process = subprocess.Popen(
                    ["node", "recover.js"],
                    cwd=str(self.script_dir),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
                )

                for line in process.stdout:
                    self.root.after(0, lambda l=line: self.insert_line(l))
                    self.root.after(0, lambda: self.log_text.see(tk.END))

                process.wait()

                if process.returncode == 0:
                    self.root.after(0, lambda: self.log("Fund recovery completed!", "SUCCESS"))
                    self.root.after(0, lambda: messagebox.showinfo("Success", "Fund recovery completed!\n\nCheck the log for details."))
                else:
                    self.root.after(0, lambda: self.log("Fund recovery failed!", "ERROR"))

            except Exception as e:
                self.root.after(0, lambda: self.log(f"Recovery error: {str(e)}", "ERROR"))

            self.root.after(0, lambda: self.status_var.set("Status: Stopped"))
            self.root.after(0, lambda: self.status_label.configure(foreground=self.MUTED))
            self.root.after(0, lambda: self.recover_btn.configure(state="normal"))

        recovery_thread = threading.Thread(target=run_recovery, daemon=True)
        recovery_thread.start()

    def disable_entries(self):
        """Disable entry fields while bot is running."""
        for entry in [self.jupiter_key_entry, self.rpc_entry, self.key_entry, self.token_entry,
                      self.min_buy_entry, self.max_buy_entry, self.concurrency_entry,
                      self.priority_fee_entry, self.sol_transfer_entry, self.slippage_entry,
                      self.delay_entry, self.vet_count_entry, self.vet_min_trades_entry,
                      self.vet_max_trades_entry, self.vet_hold_entry, self.vet_wait_min_entry,
                      self.vet_wait_max_entry]:
            entry.configure(state="disabled")
        for combo in [self.priority_level_combo, self.engine_combo, self.sender_mode_combo, self.sender_region_combo]:
            combo.configure(state="disabled")

    def enable_entries(self):
        """Enable entry fields when bot is stopped."""
        for entry in [self.jupiter_key_entry, self.rpc_entry, self.key_entry, self.token_entry,
                      self.min_buy_entry, self.max_buy_entry, self.concurrency_entry,
                      self.priority_fee_entry, self.sol_transfer_entry, self.slippage_entry,
                      self.delay_entry, self.vet_count_entry, self.vet_min_trades_entry,
                      self.vet_max_trades_entry, self.vet_hold_entry, self.vet_wait_min_entry,
                      self.vet_wait_max_entry]:
            entry.configure(state="normal")
        for combo in [self.priority_level_combo, self.engine_combo, self.sender_mode_combo, self.sender_region_combo]:
            combo.configure(state="readonly")

    def on_closing(self):
        """Handle window close event."""
        if self.running:
            if messagebox.askokcancel("Quit", "Bot is still running. Stop and exit?"):
                self.stop_bot()
                self.root.destroy()
        else:
            self.root.destroy()

    def run(self):
        """Start the GUI main loop."""
        self.root.mainloop()


def enable_crisp_text():
    """On scaled Windows displays, render at native resolution instead of blurry bitmap scaling."""
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass


def main():
    """Main entry point."""
    enable_crisp_text()
    app = BotGUI()
    app.run()


if __name__ == "__main__":
    main()
