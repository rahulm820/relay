"use client";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { ChatConnectionSchema, type ChatConnection } from "../lib/schemas";
import { toast } from "sonner";

export function AdminChatConnections() {
  const [connections, setConnections] = useState<ChatConnection[]>([]);
  const [newConnection, setNewConnection] = useState<{ provider: "slack" | "mattermost" | "teams" | "discord"; workspaceRef: string; defaultChannelRef: string }>({ provider: "slack", workspaceRef: "", defaultChannelRef: "" });
  const qc = useQueryClient();

  useEffect(() => {
    fetchConnections();
  }, []);

  const fetchConnections = async () => {
    const data = await api.chatConnections.list();
    setConnections(data);
  };

  const handleCreate = async () => {
    try {
      await api.chatConnections.create({
        provider: newConnection.provider,
        workspaceRef: newConnection.workspaceRef,
        defaultChannelRef: newConnection.defaultChannelRef,
      });
      await fetchConnections();
      setNewConnection({ provider: "slack", workspaceRef: "", defaultChannelRef: "" });
      toast.success("Chat connection added");
    } catch (err) {
      toast.error("Failed to add chat connection");
    }
  };

  return null;
}