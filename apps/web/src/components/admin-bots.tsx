"use client";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { BotSchema, type Bot } from "../lib/schemas";
import { toast } from "sonner";

export function AdminBots() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [newBot, setNewBot] = useState<{ channel: "telegram" | "whatsapp"; displayName: string; credentialsRef: string }>({ channel: "telegram", displayName: "", credentialsRef: "" });
  const [editingBot, setEditingBot] = useState<Bot | null>(null);
  const [testing, setTesting] = useState<{ botId: string | null; success: boolean }>({ botId: null, success: false });
  const qc = useQueryClient();

  useEffect(() => {
    fetchBots();
  }, []);

  const fetchBots = async () => {
    const data = await api.bots.list();
    setBots(data);
  };

  const handleCreate = async () => {
    try {
      await api.bots.create({
        channel: newBot.channel,
        displayName: newBot.displayName,
        credentialsRef: newBot.credentialsRef,
      });
      await fetchBots();
      setNewBot({ channel: "telegram", displayName: "", credentialsRef: "" });
      toast.success("Bot registered");
    } catch (err) {
      toast.error("Failed to register bot");
    }
  };

  const handleTest = async (botId: string) => {
    setTesting({ botId, success: false });
    try {
      await api.bots.test(botId);
      setTesting({ botId, success: true });
      toast.success("Bot test passed");
    } catch (err) {
      setTesting({ botId, success: false });
      toast.error("Bot test failed");
    }
  };

  const handleEdit = (bot: Bot) => setEditingBot(bot);
  const handleSave = async (bot: Bot) => {
    try {
      await api.bots.patch(bot.id, {
        displayName: bot.displayName,
        credentialsRef: bot.credentialsRef,
      });
      await fetchBots();
      setEditingBot(null);
      toast.success("Bot updated");
    } catch (err) {
      toast.error("Failed to update bot");
    }
  };
  const handleDelete = async (botId: string) => {
    if (window.confirm("Revoke this bot?")) {
      try {
        await api.bots.delete(botId);
        await fetchBots();
        toast.success("Bot revoked");
      } catch (err) {
        toast.error("Failed to revoke bot");
      }
    }
  };

  return null;
}