package run.halo.themexupdater;

import org.springframework.stereotype.Component;
import run.halo.app.core.extension.content.Comment;
import run.halo.app.extension.ListOptions;
import run.halo.app.extension.controller.Controller;
import run.halo.app.extension.controller.ControllerBuilder;
import run.halo.app.extension.controller.Reconciler;

/**
 * 盯着新评论：每进来一条交给 {@link ModerationService#process} 审一遍。
 * 启动时只补查还没有审核标记的（插件停着的时候进来的），已经审过的不再过一遍。
 */
@Component
public class CommentModerationReconciler implements Reconciler<Reconciler.Request> {

    private final ModerationService service;

    public CommentModerationReconciler(ModerationService service) {
        this.service = service;
    }

    @Override
    public Result reconcile(Request request) {
        return service.process("Comment", request.name());
    }

    @Override
    public Controller setupWith(ControllerBuilder builder) {
        return builder.extension(new Comment())
            .syncAllOnStart(true)
            .syncAllListOptions(ListOptions.builder().labelSelector().notExists(ModerationService.STATE).end().build())
            .workerCount(2)
            .build();
    }
}
