"use client";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { MemberSchema, type Member } from "../lib/schemas";
import { toast } from "sonner";

export function AdminTeamRoles() {
  const [members, setMembers] = useState<Member[]>([]);
  const [newMember, setNewMember] = useState<{ name: string; role: "designer" | "developer" | "tester" | "pm"; chatHandle: string; timezone: string; active: boolean }>({ name: "", role: "developer", chatHandle: "", timezone: "UTC", active: true });
  const qc = useQueryClient();

  useEffect(() => {
    fetchMembers();
  }, []);

  const fetchMembers = async () => {
    const data = await api.members.list();
    setMembers(data);
  };

  const handleCreate = async () => {
    try {
      await api.members.create({
        name: newMember.name,
        role: newMember.role,
        chatHandle: newMember.chatHandle || null,
        trackerHandle: null,
        timezone: newMember.timezone || "UTC",
        active: newMember.active,
      });
      await fetchMembers();
      setNewMember({ name: "", role: "developer", chatHandle: "", timezone: "UTC", active: true });
      toast.success("Member added");
    } catch (err) {
      toast.error("Failed to add member");
    }
  };

  return null;
}