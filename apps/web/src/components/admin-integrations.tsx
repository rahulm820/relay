"use client";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { IntegrationSchema, type Integration } from "../lib/schemas";
import { toast } from "sonner";

export function AdminIntegrations() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [newIntegration, setNewIntegration] = useState<{
    provider: "github" | "jira" | "linear";
    repoRef: string | null;
    credentialsRef: string | null;
    approvalPolicy: "auto" | "human";
    codeAwareEnabled: boolean;
    labelMapText: string;
  }>({
    provider: "github",
    repoRef: "",
    credentialsRef: "",
    approvalPolicy: "auto",
    codeAwareEnabled: false,
    labelMapText: "",
  });
  const qc = useQueryClient();

  useEffect(() => {
    fetchIntegrations();
  }, []);

  const fetchIntegrations = async () => {
    const data = await api.integrations.list();
    setIntegrations(data);
  };

  const handleCreate = async () => {
    try {
      await api.integrations.create({
        provider: newIntegration.provider,
        repoRef: newIntegration.repoRef || null,
        credentialsRef: newIntegration.credentialsRef || null,
        approvalPolicy: newIntegration.approvalPolicy,
        codeAwareEnabled: newIntegration.codeAwareEnabled,
        labelMap: newIntegration.labelMapText ? newIntegration.labelMapText.split("\n").reduce((acc, line) => {
          const [key, ...valueParts] = line.split(":");
          if (key && valueParts.length > 0) {
            acc[key] = valueParts.join(":").trim();
          }
          return acc;
        }, {} as Record<string, string>) : {},
      });
      await fetchIntegrations();
      toast.success("Integration connected");
    } catch (err) {
      toast.error("Failed to connect integration");
    }
  };

  const handleResync = async (id: string) => {
    try {
      await api.integrations.resync(id);
      toast.success("Re-sync started");
    } catch (err) {
      toast.error("Failed to re-sync");
    }
  };

  return null;
}