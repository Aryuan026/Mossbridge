function createServiceDomains(services = {}) {
  const asherieMemory = services.asherieMemory || null;
  const diary = services.diary || null;
  const reminder = services.reminder || null;
  const system = services.system || null;
  const channelFile = services.channelFile || null;
  const sticker = services.sticker || null;
  const timeline = services.timeline || null;
  const whereabouts = services.whereabouts || null;

  const systemTurn = {
    service: system,
    queueMessage(args = {}, context = {}) {
      return requireService(system, "systemTurn").queueMessage(args, context);
    },
  };

  const wakeup = {
    reminderService: reminder,
    systemTurnService: system,
    async scheduleReminder(args = {}, context = {}) {
      return await requireService(reminder, "wakeup.reminder").create(args, context);
    },
    queueSystemTurn(args = {}, context = {}) {
      return systemTurn.queueMessage(args, context);
    },
  };

  const calendar = {
    timelineService: timeline,
    reminderService: reminder,
    async read(args = {}) {
      return await requireService(timeline, "calendar.timeline").read(args);
    },
    async listCategories() {
      return await requireService(timeline, "calendar.timeline").listCategories();
    },
    async listProposals(args = {}) {
      return await requireService(timeline, "calendar.timeline").listProposals(args);
    },
    async write(args = {}) {
      return await requireService(timeline, "calendar.timeline").write(args);
    },
    async build(args = {}) {
      return await requireService(timeline, "calendar.timeline").build(args);
    },
    async serve(args = {}) {
      return await requireService(timeline, "calendar.timeline").serve(args);
    },
    async dev(args = {}) {
      return await requireService(timeline, "calendar.timeline").dev(args);
    },
    async captureScreenshot(args = {}) {
      return await requireService(timeline, "calendar.timeline").captureScreenshot(args);
    },
    queueScreenshot(args = {}, context = {}) {
      return requireService(timeline, "calendar.timeline").queueScreenshot(args, context);
    },
  };

  const memory = {
    asherieMemoryService: asherieMemory,
    diaryService: diary,
    async appendDiary(args = {}) {
      return await requireService(diary, "memory.diary").append(args);
    },
    async captureContextPacket(args = {}) {
      return await requireService(asherieMemory, "memory.captureContextPacket").captureContextPacket(args);
    },
    async writebackTurn(args = {}) {
      return await requireService(asherieMemory, "memory.writebackTurn").writebackTurn(args);
    },
    async writeWarmMaterial(args = {}) {
      return await requireService(asherieMemory, "memory.writeWarmMaterial").writeWarmMaterial(args);
    },
    async readWarmMaterial(args = {}) {
      return await requireService(asherieMemory, "memory.readWarmMaterial").readWarmMaterial(args);
    },
    async searchWarmMaterials(args = {}) {
      return await requireService(asherieMemory, "memory.searchWarmMaterials").searchWarmMaterials(args);
    },
    async listWarmMaterials(args = {}) {
      return await requireService(asherieMemory, "memory.listWarmMaterials").listWarmMaterials(args);
    },
    async updateWarmMaterial(args = {}) {
      return await requireService(asherieMemory, "memory.updateWarmMaterial").updateWarmMaterial(args);
    },
    async deleteWarmMaterial(args = {}) {
      return await requireService(asherieMemory, "memory.deleteWarmMaterial").deleteWarmMaterial(args);
    },
    async upsertOngoingTrack(args = {}) {
      return await requireService(asherieMemory, "memory.upsertOngoingTrack").upsertOngoingTrack(args);
    },
    async readOngoingTrack(args = {}) {
      return await requireService(asherieMemory, "memory.readOngoingTrack").readOngoingTrack(args);
    },
    async listOngoingTracks(args = {}) {
      return await requireService(asherieMemory, "memory.listOngoingTracks").listOngoingTracks(args);
    },
    async closeOngoingTrack(args = {}) {
      return await requireService(asherieMemory, "memory.closeOngoingTrack").closeOngoingTrack(args);
    },
    async appendObservation(args = {}) {
      return await requireService(asherieMemory, "memory.appendObservation").appendObservation(args);
    },
    async searchObservations(args = {}) {
      return await requireService(asherieMemory, "memory.searchObservations").searchObservations(args);
    },
    async readObservation(args = {}) {
      return await requireService(asherieMemory, "memory.readObservation").readObservation(args);
    },
    async updateObservation(args = {}) {
      return await requireService(asherieMemory, "memory.updateObservation").updateObservation(args);
    },
    async listColdVersions(args = {}) {
      return await requireService(asherieMemory, "memory.listColdVersions").listColdVersions(args);
    },
    async readColdVersion(args = {}) {
      return await requireService(asherieMemory, "memory.readColdVersion").readColdVersion(args);
    },
    async searchColdRoots(args = {}) {
      return await requireService(asherieMemory, "memory.searchColdRoots").searchColdRoots(args);
    },
    async readColdRoot(args = {}) {
      return await requireService(asherieMemory, "memory.readColdRoot").readColdRoot(args);
    },
    async patchColdRoot(args = {}) {
      return await requireService(asherieMemory, "memory.patchColdRoot").patchColdRoot(args);
    },
    async upsertColdVersion(args = {}) {
      return await requireService(asherieMemory, "memory.upsertColdVersion").upsertColdVersion(args);
    },
    describe() {
      return requireService(asherieMemory, "memory.describe").describe();
    },
  };

  const transport = {
    channelFileService: channelFile,
    stickerService: sticker,
    async sendFileToCurrentChat(args = {}, context = {}) {
      return await requireService(channelFile, "transport.channelFile").sendToCurrentChat(args, context);
    },
    async listStickers(args = {}) {
      return await requireService(sticker, "transport.sticker").list(args);
    },
    async pickSticker(args = {}) {
      return await requireService(sticker, "transport.sticker").pick(args);
    },
    async sendStickerToCurrentChat(args = {}, context = {}) {
      return await requireService(sticker, "transport.sticker").sendToCurrentChat(args, context);
    },
    async saveStickerFromInbox(args = {}, context = {}) {
      return await requireService(sticker, "transport.sticker").saveFromInbox(args, context);
    },
  };

  const presence = {
    whereaboutsService: whereabouts,
    async startWhereaboutsServer(options = {}) {
      return await requireService(whereabouts, "presence.whereabouts").startServer(options);
    },
    async closeWhereaboutsServer() {
      return await requireService(whereabouts, "presence.whereabouts").closeServer();
    },
    getWhereaboutsServer() {
      return whereabouts?.server || null;
    },
  };

  return {
    memory,
    wakeup,
    calendar,
    systemTurn,
    transport,
    presence,
    raw: {
      diary,
      asherieMemory,
      reminder,
      system,
      channelFile,
      sticker,
      timeline,
      whereabouts,
    },
  };
}

function requireService(service, label) {
  if (service) {
    return service;
  }
  throw new Error(`${label} service is not configured`);
}

module.exports = { createServiceDomains };
